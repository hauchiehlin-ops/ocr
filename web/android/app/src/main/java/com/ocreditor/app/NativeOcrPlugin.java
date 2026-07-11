package com.ocreditor.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.lang.reflect.Method;

@CapacitorPlugin(name = "NativeOcr")
public class NativeOcrPlugin extends Plugin {
    private final TextRecognizer recognizer =
        TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());

    @PluginMethod
    public void recognize(PluginCall call) {
        String imageData = call.getString("image");
        if (imageData == null || imageData.trim().isEmpty()) {
            call.reject("Missing image data.");
            return;
        }

        Bitmap bitmap;
        try {
            bitmap = decodeDataUrl(imageData);
        } catch (IllegalArgumentException ex) {
            call.reject("Invalid image data.", ex);
            return;
        }

        if (bitmap == null || bitmap.getWidth() <= 0 || bitmap.getHeight() <= 0) {
            call.reject("Unable to decode image.");
            return;
        }

        InputImage inputImage = InputImage.fromBitmap(bitmap, 0);
        recognizer.process(inputImage)
            .addOnSuccessListener(text -> {
                try {
                    call.resolve(buildResponse(text, bitmap.getWidth(), bitmap.getHeight()));
                } finally {
                    bitmap.recycle();
                }
            })
            .addOnFailureListener(error -> {
                bitmap.recycle();
                call.reject("Android ML Kit OCR failed: " + error.getMessage(), error);
            });
    }

    private Bitmap decodeDataUrl(String imageData) {
        int commaIndex = imageData.indexOf(',');
        String base64Payload = commaIndex >= 0 ? imageData.substring(commaIndex + 1) : imageData;
        byte[] imageBytes = Base64.decode(base64Payload, Base64.DEFAULT);
        return BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
    }

    private JSObject buildResponse(Text visionText, int imageWidth, int imageHeight) {
        JSArray results = new JSArray();

        for (Text.TextBlock block : visionText.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                addLine(results, line, imageWidth, imageHeight);
            }
        }

        JSObject response = new JSObject();
        response.put("engine", "Android ML Kit");
        response.put("results", results);
        return response;
    }

    private void addLine(JSArray results, Text.Line line, int imageWidth, int imageHeight) {
        String text = line.getText();
        Rect box = line.getBoundingBox();
        if (text == null || text.trim().isEmpty() || box == null) {
            return;
        }

        int left = clamp(box.left, 0, imageWidth);
        int top = clamp(box.top, 0, imageHeight);
        int right = clamp(box.right, 0, imageWidth);
        int bottom = clamp(box.bottom, 0, imageHeight);
        if (right <= left || bottom <= top) {
            return;
        }

        JSArray bbox = new JSArray();
        bbox.put(normalize(top, imageHeight));
        bbox.put(normalize(left, imageWidth));
        bbox.put(normalize(bottom, imageHeight));
        bbox.put(normalize(right, imageWidth));

        JSObject item = new JSObject();
        item.put("text", text.trim());
        item.put("bbox", bbox);
        item.put("confidence", getConfidence(line, 0.85));
        item.put("source", "android-mlkit");
        results.put(item);
    }

    private int normalize(int value, int max) {
        if (max <= 0) return 0;
        return clamp((int) Math.round((value * 1000.0) / max), 0, 1000);
    }

    private int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private double getConfidence(Object recognizerObject, double fallback) {
        try {
            Method method = recognizerObject.getClass().getMethod("getConfidence");
            Object value = method.invoke(recognizerObject);
            if (value instanceof Number) {
                double confidence = ((Number) value).doubleValue();
                if (!Double.isNaN(confidence) && !Double.isInfinite(confidence)) {
                    return confidence;
                }
            }
        } catch (Exception ignored) {
            // ML Kit versions differ in confidence availability. Keep a stable fallback.
        }
        return fallback;
    }
}
