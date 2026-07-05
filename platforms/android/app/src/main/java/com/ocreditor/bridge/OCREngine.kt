/**
 * @file OCREngine.kt
 * @brief Kotlin wrapper for the native OCR engine (JNI).
 *
 * Provides a high-level, type-safe API for:
 *   - Engine initialisation and teardown
 *   - Running OCR recognition on Android [Bitmap] images
 *   - Removing (inpainting) text regions
 *   - Replacing text content within bounding boxes (stub)
 *
 * All data classes are annotated with `@Serializable` for easy JSON
 * round-tripping via `kotlinx.serialization`.
 *
 * Usage:
 * ```kotlin
 * val engine = OCREngine(context)
 * val result = engine.recognize(bitmap)
 * result?.blocks?.forEach { block ->
 *     block.lines.forEach { line ->
 *         Log.d("OCR", line.text)
 *     }
 * }
 * engine.release()
 * ```
 *
 * @copyright 2026 OCR Visual Editor Contributors
 * @license Apache-2.0
 */

package com.ocreditor.bridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.RectF
import android.util.Log
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.io.IOException

// ---------------------------------------------------------------------------
// Serialisable data models
// ---------------------------------------------------------------------------

/**
 * Top-level OCR recognition result for an entire image.
 *
 * @property dimensions The source image dimensions.
 * @property blocks     Detected text blocks (paragraphs / regions).
 * @property confidence Overall recognition confidence in `[0.0, 1.0]`.
 */
@Serializable
data class OCRResult(
    @SerialName("dimensions") val dimensions: ImageDimensions,
    @SerialName("blocks")     val blocks: List<TextBlock> = emptyList(),
    @SerialName("confidence") val confidence: Float = 0f,
) {
    /** Concatenation of all block texts separated by newlines. */
    val fullText: String
        get() = blocks.joinToString("\n") { it.text }

    /** Total number of recognised words across all blocks. */
    val wordCount: Int
        get() = blocks.sumOf { block ->
            block.lines.sumOf { line -> line.words.size }
        }
}

/**
 * Source image dimensions returned alongside recognition results.
 *
 * @property width  Image width in pixels.
 * @property height Image height in pixels.
 */
@Serializable
data class ImageDimensions(
    @SerialName("width")  val width: Int,
    @SerialName("height") val height: Int,
)

/**
 * A detected text block, roughly corresponding to a paragraph or
 * visually distinct region of text.
 *
 * @property text       The full text content of the block.
 * @property boundingBox Axis-aligned bounding box enclosing the block.
 * @property lines      Individual text lines within the block.
 * @property confidence Block-level recognition confidence.
 */
@Serializable
data class TextBlock(
    @SerialName("text")         val text: String,
    @SerialName("bounding_box") val boundingBox: BoundingBox,
    @SerialName("lines")        val lines: List<TextLine> = emptyList(),
    @SerialName("confidence")   val confidence: Float = 0f,
)

/**
 * A single line of text within a [TextBlock].
 *
 * @property text       The text content of the line.
 * @property boundingBox Axis-aligned bounding box for the line.
 * @property words      Individual words detected on this line.
 * @property confidence Line-level recognition confidence.
 */
@Serializable
data class TextLine(
    @SerialName("text")         val text: String,
    @SerialName("bounding_box") val boundingBox: BoundingBox,
    @SerialName("words")        val words: List<TextWord> = emptyList(),
    @SerialName("confidence")   val confidence: Float = 0f,
)

/**
 * A single word detected within a [TextLine].
 *
 * @property text        The recognised word text.
 * @property boundingBox Axis-aligned bounding box for the word.
 * @property confidence  Word-level recognition confidence.
 * @property font        Optional estimated font properties.
 */
@Serializable
data class TextWord(
    @SerialName("text")         val text: String,
    @SerialName("bounding_box") val boundingBox: BoundingBox,
    @SerialName("confidence")   val confidence: Float = 0f,
    @SerialName("font")         val font: FontEstimate? = null,
)

/**
 * An axis-aligned bounding box defined by its top-left corner and size.
 *
 * Coordinates are in image-pixel space (origin = top-left of the image).
 *
 * @property x      Left edge (pixels).
 * @property y      Top edge (pixels).
 * @property width  Box width (pixels).
 * @property height Box height (pixels).
 */
@Serializable
data class BoundingBox(
    @SerialName("x")      val x: Float,
    @SerialName("y")      val y: Float,
    @SerialName("width")  val width: Float,
    @SerialName("height") val height: Float,
) {
    /**
     * Convert to an Android [RectF] (left, top, right, bottom).
     */
    fun toRectF(): RectF = RectF(x, y, x + width, y + height)

    /**
     * Flatten to a `FloatArray` of `[x, y, width, height]` suitable for
     * passing through JNI.
     */
    fun toFloatArray(): FloatArray = floatArrayOf(x, y, width, height)
}

/**
 * Estimated typographic properties for a recognised word.
 *
 * @property family   Font family name (e.g. "Arial", "Times New Roman").
 * @property size     Estimated font size in points.
 * @property isBold   Whether the text appears bold.
 * @property isItalic Whether the text appears italic.
 * @property color    Hex colour string (e.g. "#FF0000").
 */
@Serializable
data class FontEstimate(
    @SerialName("family")    val family: String = "Unknown",
    @SerialName("size")      val size: Float = 12f,
    @SerialName("is_bold")   val isBold: Boolean = false,
    @SerialName("is_italic") val isItalic: Boolean = false,
    @SerialName("color")     val color: String = "#000000",
)

// ---------------------------------------------------------------------------
// Engine wrapper
// ---------------------------------------------------------------------------

/**
 * High-level wrapper around the native OCR engine loaded via JNI.
 *
 * Manages the native handle lifecycle and provides Kotlin-idiomatic methods
 * for OCR recognition and text manipulation.
 *
 * **Important:** call [release] when done to free native resources. The
 * engine also releases itself in [finalize] as a safety net, but relying on
 * finalisation is discouraged.
 *
 * @param context An Android [Context] used to locate bundled model assets.
 */
class OCREngine(private val context: Context) {

    /** Opaque pointer to the native `OcrEngine` struct (cast to Long). */
    private var nativeHandle: Long = 0L

    /**
     * `true` after the engine has been successfully initialised and has not
     * yet been released.
     */
    val isReady: Boolean
        get() = nativeHandle != 0L

    init {
        val modelDir = copyModelsToInternal()
        nativeHandle = nativeCreate(modelDir)
        if (nativeHandle == 0L) {
            Log.e(TAG, "Failed to initialise native OCR engine")
        } else {
            Log.i(TAG, "OCR engine initialised (handle=$nativeHandle)")
        }
    }

    // -- Public API ---------------------------------------------------------

    /**
     * Run OCR recognition on the given [bitmap].
     *
     * @param bitmap An ARGB_8888 bitmap to analyse.
     * @return The parsed [OCRResult], or `null` if recognition failed.
     */
    fun recognize(bitmap: Bitmap): OCRResult? {
        check(isReady) { "OCR engine is not initialised – call release() was already invoked?" }
        return try {
            val json = nativeRecognize(nativeHandle, bitmap)
            if (json != null) parseOCRResult(json) else null
        } catch (e: Exception) {
            Log.e(TAG, "Recognition failed", e)
            null
        }
    }

    /**
     * Remove (inpaint) text from the image at the given bounding boxes.
     *
     * @param bitmap Source bitmap (ARGB_8888).
     * @param boxes  List of bounding boxes identifying text regions to remove.
     * @return A new [Bitmap] with text regions inpainted, or `null` on failure.
     */
    fun removeText(bitmap: Bitmap, boxes: List<BoundingBox>): Bitmap? {
        check(isReady) { "OCR engine is not initialised" }
        if (boxes.isEmpty()) {
            Log.w(TAG, "removeText called with empty box list")
            return bitmap.copy(bitmap.config, true)
        }

        val flatBoxes = FloatArray(boxes.size * 4)
        boxes.forEachIndexed { index, box ->
            val arr = box.toFloatArray()
            System.arraycopy(arr, 0, flatBoxes, index * 4, 4)
        }

        return try {
            nativeRemoveText(nativeHandle, bitmap, flatBoxes, boxes.size)
        } catch (e: Exception) {
            Log.e(TAG, "Text removal failed", e)
            null
        }
    }

    /**
     * Replace text within a bounding box with new content.
     *
     * @note This is a **stub** – the underlying native implementation is not
     *       yet available. Calling this method currently returns `null`.
     *
     * @param bitmap  Source bitmap (ARGB_8888).
     * @param box     Bounding box of the text to replace.
     * @param newText Replacement text to render into the region.
     * @return A new [Bitmap] with the replacement, or `null` (stub).
     */
    fun replaceText(bitmap: Bitmap, box: BoundingBox, newText: String): Bitmap? {
        check(isReady) { "OCR engine is not initialised" }
        return try {
            nativeReplaceText(nativeHandle, bitmap, box.toFloatArray(), newText)
        } catch (e: Exception) {
            Log.e(TAG, "Text replacement failed", e)
            null
        }
    }

    /**
     * Release native resources held by this engine instance.
     *
     * After calling this method, [isReady] returns `false` and any further
     * calls to [recognize], [removeText], or [replaceText] will throw.
     */
    fun release() {
        if (nativeHandle != 0L) {
            Log.i(TAG, "Releasing native OCR engine (handle=$nativeHandle)")
            nativeDestroy(nativeHandle)
            nativeHandle = 0L
        }
    }

    @Suppress("deprecation")
    protected fun finalize() {
        if (nativeHandle != 0L) {
            Log.w(TAG, "OCREngine finalised without explicit release() – cleaning up")
            release()
        }
    }

    // -- Internal helpers ---------------------------------------------------

    /**
     * Copy bundled model assets from the APK's `assets/models/` directory
     * into the app's internal files directory so the native code can access
     * them via a regular filesystem path.
     *
     * @return Absolute path to the internal model directory.
     * @throws IOException if any asset copy fails.
     */
    private fun copyModelsToInternal(): String {
        val modelsDir = File(context.filesDir, MODELS_DIR_NAME)
        if (modelsDir.exists() && modelsDir.listFiles()?.isNotEmpty() == true) {
            Log.d(TAG, "Models already present at ${modelsDir.absolutePath}")
            return modelsDir.absolutePath
        }

        modelsDir.mkdirs()

        try {
            val assetManager = context.assets
            val assetList = assetManager.list(MODELS_ASSET_PATH) ?: emptyArray()

            if (assetList.isEmpty()) {
                Log.w(TAG, "No model assets found at '$MODELS_ASSET_PATH'")
                return modelsDir.absolutePath
            }

            for (filename in assetList) {
                val assetPath = "$MODELS_ASSET_PATH/$filename"
                val outFile = File(modelsDir, filename)

                assetManager.open(assetPath).use { input ->
                    outFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
                Log.d(TAG, "Copied model asset: $filename (${outFile.length()} bytes)")
            }

            Log.i(TAG, "Model assets copied to ${modelsDir.absolutePath}")
        } catch (e: IOException) {
            Log.e(TAG, "Failed to copy model assets", e)
            throw e
        }

        return modelsDir.absolutePath
    }

    /**
     * Parse the JSON string returned by the native recognition call into a
     * strongly-typed [OCRResult].
     *
     * Uses `kotlinx.serialization.json.Json` with lenient settings so that
     * minor schema mismatches (e.g. unknown keys from newer engine versions)
     * do not cause hard failures.
     */
    private fun parseOCRResult(json: String): OCRResult {
        return jsonParser.decodeFromString(OCRResult.serializer(), json)
    }

    // -- JNI declarations ---------------------------------------------------

    private external fun nativeCreate(modelDir: String): Long
    private external fun nativeDestroy(handle: Long)
    private external fun nativeRecognize(handle: Long, bitmap: Bitmap): String?
    private external fun nativeRemoveText(
        handle: Long,
        bitmap: Bitmap,
        bboxArray: FloatArray,
        bboxCount: Int,
    ): Bitmap?
    private external fun nativeReplaceText(
        handle: Long,
        bitmap: Bitmap,
        bbox: FloatArray,
        newText: String,
    ): Bitmap?

    // -- Companion ----------------------------------------------------------

    companion object {
        private const val TAG = "OCREngine"

        /** Name of the shared library loaded via [System.loadLibrary]. */
        private const val NATIVE_LIB_NAME = "ocr_core"

        /** Subdirectory under `assets/` where model files are stored. */
        private const val MODELS_ASSET_PATH = "models"

        /** Subdirectory under internal files where models are unpacked. */
        private const val MODELS_DIR_NAME = "ocr_models"

        /** Lenient JSON parser for deserialising native results. */
        private val jsonParser = Json {
            ignoreUnknownKeys = true
            isLenient = true
            coerceInputValues = true
        }

        init {
            try {
                System.loadLibrary(NATIVE_LIB_NAME)
                Log.i(TAG, "Loaded native library '$NATIVE_LIB_NAME'")
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "Failed to load native library '$NATIVE_LIB_NAME'", e)
                throw e
            }
        }
    }
}
