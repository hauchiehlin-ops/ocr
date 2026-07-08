// ---------------------------------------------------------------------------
// OCREngineInterop.cs
// ---------------------------------------------------------------------------
// C# P/Invoke bridge to the native OCR core engine (ocr_core.dll).
//
// Provides:
//   - Low-level DllImport declarations for every C API entry point
//   - A high-level OCREngineInterop class implementing IDisposable
//   - Managed data models that mirror the cross-platform JSON schema
//   - Bitmap ↔ RGBA byte-buffer conversion helpers
//
// Usage:
//   using var engine = new OCREngineInterop(@"C:\models\ocr");
//   var result = engine.Recognize(bitmap);
//   Console.WriteLine(result?.FullText);
//
// Build requirements:
//   - .NET 6.0+ / .NET Framework 4.7.2+
//   - System.Drawing.Common (for Bitmap support)
//   - System.Text.Json (for JSON deserialisation)
//   - ocr_core.dll in the runtime output directory
//
// Copyright 2026 OCR Visual Editor Contributors
// Licensed under Apache-2.0
// ---------------------------------------------------------------------------

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace OCREditor.Interop
{
    // -----------------------------------------------------------------------
    // Native P/Invoke declarations
    // -----------------------------------------------------------------------

    /// <summary>
    /// Raw P/Invoke signatures for the <c>ocr_core</c> native library.
    /// These are internal implementation details; consumers should use
    /// <see cref="OCREngineInterop"/> instead.
    /// </summary>
    internal static class NativeMethods
    {
        private const string DllName = "ocr_core";

        /// <summary>
        /// Create a new OCR engine instance from a model directory.
        /// </summary>
        /// <param name="modelDir">Absolute path to the model directory.</param>
        /// <returns>An opaque engine handle, or <see cref="IntPtr.Zero"/> on failure.</returns>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_engine_create", CharSet = CharSet.Ansi)]
        internal static extern IntPtr ocr_engine_create(
            [MarshalAs(UnmanagedType.LPStr)] string modelDir,
            [MarshalAs(UnmanagedType.LPStr)] string configJson);

        /// <summary>
        /// Destroy a previously created engine and free its resources.
        /// </summary>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_engine_destroy")]
        internal static extern void ocr_engine_destroy(IntPtr engine);

        /// <summary>
        /// Run OCR recognition on raw RGBA pixel data.
        /// </summary>
        /// <returns>A heap-allocated UTF-8 JSON string (must be freed with
        /// <see cref="ocr_free_string"/>), or <see cref="IntPtr.Zero"/>.</returns>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_recognize")]
        internal static extern IntPtr ocr_recognize(
            IntPtr engine,
            byte[] pixels,
            int width,
            int height,
            int channels);

        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_recognize_region")]
        internal static extern IntPtr ocr_recognize_region(
            IntPtr engine,
            byte[] pixels,
            int width,
            int height,
            int channels,
            int x, int y, int w, int h);

        /// <summary>
        /// Remove (inpaint) text regions defined by bounding boxes.
        /// </summary>
        /// <returns>A pointer to an <c>OcrImageResult</c> struct (must be
        /// freed with <see cref="ocr_free_image_result"/>), or
        /// <see cref="IntPtr.Zero"/>.</returns>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_remove_text")]
        internal static extern IntPtr ocr_remove_text(
            IntPtr engine,
            byte[] pixels,
            int width,
            int height,
            int channels,
            [In] NativeBBox[] boxes,
            int boxCount);        /// <summary>
        /// Replace text in a region with new content.
        /// </summary>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_replace_text")]
        internal static extern IntPtr ocr_replace_text(
            IntPtr engine,
            byte[] pixels,
            int width,
            int height,
            int channels,
            ref NativeBBox box,
            [MarshalAs(UnmanagedType.LPStr)] string newText,
            [MarshalAs(UnmanagedType.LPStr)] string fontConfigJson);

        /// <summary>
        /// Free a heap-allocated string returned by the native library.
        /// </summary>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_free_string")]
        internal static extern void ocr_free_string(IntPtr str);

        /// <summary>
        /// Free a heap-allocated image result returned by the native library.
        /// </summary>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_free_image_result")]
        internal static extern void ocr_free_image_result(IntPtr imageResult);

        /// <summary>
        /// Parse a PPTX file and export its slides and layers as a JSON string.
        /// </summary>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_parse_pptx", CharSet = CharSet.Ansi)]
        internal static extern IntPtr ocr_parse_pptx(
            IntPtr engine,
            [MarshalAs(UnmanagedType.LPStr)] string pptxPath);

        /// <summary>
        /// Replace the image content of a specific image layer.
        /// </summary>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_canvas_replace_layer_image", CharSet = CharSet.Ansi)]
        internal static extern int ocr_canvas_replace_layer_image(
            IntPtr engine,
            [MarshalAs(UnmanagedType.LPStr)] string layerId,
            byte[] newPixels,
            int width,
            int height);

        /// <summary>
        /// Save a document to the OCR history database.
        /// </summary>
        [DllImport(DllName, CallingConvention = CallingConvention.Cdecl,
                   EntryPoint = "ocr_history_save_document", CharSet = CharSet.Ansi)]
        internal static extern int ocr_history_save_document(
            [MarshalAs(UnmanagedType.LPStr)] string docId,
            [MarshalAs(UnmanagedType.LPStr)] string jsonData,
            [MarshalAs(UnmanagedType.LPStr)] string title,
            [MarshalAs(UnmanagedType.LPStr)] string previewImagePath);
     }

    // -----------------------------------------------------------------------
    // Native struct
    // -----------------------------------------------------------------------

    /// <summary>
    /// Blittable bounding-box struct matching the C <c>OCRBBox</c> layout.
    /// Used exclusively for P/Invoke marshalling.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeBBox
    {
        public float TopLeftX, TopLeftY;
        public float TopRightX, TopRightY;
        public float BottomRightX, BottomRightY;
        public float BottomLeftX, BottomLeftY;
    }

    // -----------------------------------------------------------------------
    // Managed data models
    // -----------------------------------------------------------------------

    /// <summary>
    /// Top-level OCR recognition result for an entire image.
    /// </summary>
    public sealed class OCRResult
    {
        [JsonPropertyName("dimensions")]
        public ImageDimensions Dimensions { get; set; } = new();

        [JsonPropertyName("blocks")]
        public List<TextBlock> Blocks { get; set; } = new();

        [JsonPropertyName("confidence")]
        public float Confidence { get; set; }

        /// <summary>
        /// Concatenation of all block texts, separated by newlines.
        /// </summary>
        [JsonIgnore]
        public string FullText =>
            string.Join(Environment.NewLine, Blocks.Select(b => b.Text));

        /// <summary>
        /// Total number of recognised words across all blocks.
        /// </summary>
        [JsonIgnore]
        public int WordCount =>
            Blocks.Sum(b => b.Lines.Sum(l => l.Words.Count));
    }

    /// <summary>
    /// Source image dimensions returned alongside recognition results.
    /// </summary>
    public sealed class ImageDimensions
    {
        [JsonPropertyName("width")]
        public int Width { get; set; }

        [JsonPropertyName("height")]
        public int Height { get; set; }
    }

    /// <summary>
    /// A detected text block (paragraph or region).
    /// </summary>
    public sealed class TextBlock
    {
        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;

        [JsonPropertyName("bounding_box")]
        public BoundingBox BoundingBox { get; set; } = new();

        [JsonPropertyName("lines")]
        public List<TextLine> Lines { get; set; } = new();

        [JsonPropertyName("confidence")]
        public float Confidence { get; set; }
    }

    /// <summary>
    /// A single line of text within a <see cref="TextBlock"/>.
    /// </summary>
    public sealed class TextLine
    {
        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;

        [JsonPropertyName("bounding_box")]
        public BoundingBox BoundingBox { get; set; } = new();

        [JsonPropertyName("words")]
        public List<TextWord> Words { get; set; } = new();

        [JsonPropertyName("confidence")]
        public float Confidence { get; set; }
    }

    /// <summary>
    /// A single recognised word.
    /// </summary>
    public sealed class TextWord
    {
        [JsonPropertyName("text")]
        public string Text { get; set; } = string.Empty;

        [JsonPropertyName("bounding_box")]
        public BoundingBox BoundingBox { get; set; } = new();

        [JsonPropertyName("confidence")]
        public float Confidence { get; set; }

        [JsonPropertyName("font")]
        public FontEstimate? Font { get; set; }
    }

    /// <summary>
    /// Axis-aligned bounding box (top-left origin, pixel coordinates).
    /// </summary>
    public sealed class BoundingBox
    {
        [JsonPropertyName("x")]
        public float X { get; set; }

        [JsonPropertyName("y")]
        public float Y { get; set; }

        [JsonPropertyName("width")]
        public float Width { get; set; }

        [JsonPropertyName("height")]
        public float Height { get; set; }

        /// <summary>
        /// Convert to a <see cref="RectangleF"/> (X, Y, Width, Height).
        /// </summary>
        public RectangleF ToRectangleF() => new(X, Y, Width, Height);

        /// <summary>
        /// Convert to the blittable <see cref="NativeBBox"/> for P/Invoke.
        /// </summary>
        internal NativeBBox ToNative() => new()
        {
            TopLeftX = X,
            TopLeftY = Y,
            TopRightX = X + Width,
            TopRightY = Y,
            BottomRightX = X + Width,
            BottomRightY = Y + Height,
            BottomLeftX = X,
            BottomLeftY = Y + Height,
        };
    }

    /// <summary>
    /// Estimated typographic properties for a recognised word.
    /// </summary>
    public sealed class FontEstimate
    {
        [JsonPropertyName("family")]
        public string Family { get; set; } = "Unknown";

        [JsonPropertyName("size")]
        public float Size { get; set; } = 12f;

        [JsonPropertyName("is_bold")]
        public bool IsBold { get; set; }

        [JsonPropertyName("is_italic")]
        public bool IsItalic { get; set; }

        [JsonPropertyName("color")]
        public string Color { get; set; } = "#000000";
    }

    // -----------------------------------------------------------------------
    // High-level engine wrapper
    // -----------------------------------------------------------------------

    /// <summary>
    /// Managed wrapper around the native OCR engine.
    ///
    /// Implements <see cref="IDisposable"/> for deterministic cleanup of the
    /// unmanaged engine handle.  A destructor (finaliser) is provided as a
    /// safety net for callers that forget to dispose.
    ///
    /// <para><b>Thread safety:</b> this class is <b>not</b> thread-safe.
    /// Callers must synchronise access if sharing an instance across threads.</para>
    /// </summary>
    public sealed class OCREngineInterop : IDisposable
    {
        private IntPtr _engineHandle;
        private bool _disposed;

        /// <summary>
        /// Shared <see cref="JsonSerializerOptions"/> for deserialising
        /// native JSON results.
        /// </summary>
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        /// <summary>
        /// Initialise the OCR engine with models from <paramref name="modelDirectory"/>.
        /// </summary>
        /// <param name="modelDirectory">
        /// Absolute path to the directory containing model files.
        /// </param>
        /// <exception cref="InvalidOperationException">
        /// Thrown if the native engine could not be created.
        /// </exception>
        /// <exception cref="ArgumentNullException">
        /// Thrown if <paramref name="modelDirectory"/> is <c>null</c>.
        /// </exception>
        public OCREngineInterop(string modelDirectory, string language = "ch_tra,eng")
        {
            if (modelDirectory is null)
                throw new ArgumentNullException(nameof(modelDirectory));

            string configJson = $"{{\"language\":\"{language}\"}}";
            _engineHandle = NativeMethods.ocr_engine_create(modelDirectory, configJson);

            if (_engineHandle == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    $"Failed to create native OCR engine from '{modelDirectory}'.");
            }
        }

        /// <summary>
        /// <c>true</c> while the engine is initialised and not yet disposed.
        /// </summary>
        public bool IsReady => _engineHandle != IntPtr.Zero && !_disposed;

        // -- Public API -----------------------------------------------------

        /// <summary>
        /// Run OCR recognition on a GDI+ <see cref="Bitmap"/>.
        /// </summary>
        /// <param name="bitmap">
        /// The source image. Must use <see cref="PixelFormat.Format32bppArgb"/>
        /// or another 32-bpp format.
        /// </param>
        /// <returns>
        /// A parsed <see cref="OCRResult"/>, or <c>null</c> if recognition
        /// failed.
        /// </returns>
        /// <exception cref="ObjectDisposedException">
        /// Thrown if the engine has already been disposed.
        /// </exception>
        public OCRResult? Recognize(Bitmap bitmap)
        {
            ThrowIfDisposed();

            var (pixels, width, height) = BitmapToRgba(bitmap);

            try
            {
                IntPtr jsonPtr = NativeMethods.ocr_recognize(
                    _engineHandle, pixels, width, height, channels: 4);

                if (jsonPtr == IntPtr.Zero)
                    return null;

                try
                {
                    string json = Marshal.PtrToStringUTF8(jsonPtr) ?? string.Empty;
                    return JsonSerializer.Deserialize<OCRResult>(json, JsonOptions);
                }
                finally
                {
                    NativeMethods.ocr_free_string(jsonPtr);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OCREngineInterop] Native Exception in Recognize: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Run OCR recognition on a specific region of a GDI+ <see cref="Bitmap"/>.
        /// </summary>
        public OCRResult? RecognizeRegion(Bitmap bitmap, Rectangle region)
        {
            ThrowIfDisposed();

            var (pixels, width, height) = BitmapToRgba(bitmap);

            try
            {
                IntPtr jsonPtr = NativeMethods.ocr_recognize_region(
                    _engineHandle, pixels, width, height, 4, region.X, region.Y, region.Width, region.Height);

                if (jsonPtr == IntPtr.Zero)
                    return null;

                try
                {
                    string json = Marshal.PtrToStringUTF8(jsonPtr) ?? string.Empty;
                    return JsonSerializer.Deserialize<OCRResult>(json, JsonOptions);
                }
                finally
                {
                    NativeMethods.ocr_free_string(jsonPtr);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OCREngineInterop] Native Exception in RecognizeRegion: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Remove (inpaint) text at the specified bounding boxes.
        /// </summary>
        /// <param name="bitmap">Source image.</param>
        /// <param name="boxes">Regions to inpaint.</param>
        /// <returns>
        /// A new <see cref="Bitmap"/> with the text removed, or <c>null</c>
        /// on failure.
        /// </returns>
        /// <remarks>
        /// This is a <b>stub</b> — the native result is not yet converted
        /// back to a managed Bitmap.  The P/Invoke call is wired up so that
        /// integration is seamless once the result-to-bitmap conversion is
        /// implemented.
        /// </remarks>
        public Bitmap? RemoveText(Bitmap bitmap, BoundingBox[] boxes)
        {
            ThrowIfDisposed();

            if (boxes is null || boxes.Length == 0)
                return (Bitmap)bitmap.Clone();

            var (pixels, width, height) = BitmapToRgba(bitmap);

            NativeBBox[] nativeBoxes = boxes
                .Select(b => b.ToNative())
                .ToArray();

            try
            {
                IntPtr resultPtr = NativeMethods.ocr_remove_text(
                    _engineHandle, pixels, width, height,
                    channels: 4, nativeBoxes, nativeBoxes.Length);

                if (resultPtr == IntPtr.Zero)
                    return null;

                try
                {
                    // TODO: Convert OcrImageResult pixels back to a managed Bitmap.
                    // For now, return a clone of the original to satisfy the API
                    // contract without crashing.
                    return (Bitmap)bitmap.Clone();
                }
                finally
                {
                    NativeMethods.ocr_free_image_result(resultPtr);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OCREngineInterop] Native Exception in RemoveText: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Replace text in a region with new content.
        /// </summary>
        /// <param name="bitmap">Source image.</param>
        /// <param name="box">Bounding box of the text to replace.</param>
        /// <param name="newText">Replacement text.</param>
        /// <returns>A new <see cref="Bitmap"/>, or <c>null</c> (stub).</returns>
        /// <remarks>
        /// This is a <b>stub</b> — the native <c>ocr_replace_text</c>
        /// function is not yet implemented. This method always returns
        /// <c>null</c>.
        /// </remarks>
        public Bitmap? ReplaceText(Bitmap bitmap, BoundingBox box, string newText)
        {
            ThrowIfDisposed();

            if (box is null || string.IsNullOrEmpty(newText))
                return (Bitmap)bitmap.Clone();

            var (pixels, width, height) = BitmapToRgba(bitmap);
            NativeBBox nativeBox = box.ToNative();

            try
            {
                IntPtr resultPtr = NativeMethods.ocr_replace_text(
                    _engineHandle, pixels, width, height,
                    channels: 4, ref nativeBox, newText, fontConfigJson: null);

                if (resultPtr == IntPtr.Zero)
                    return null;

                try
                {
                    // TODO: Convert OcrImageResult pixels back to a managed Bitmap.
                    // For now, return a clone of the original to satisfy the API
                    // contract without crashing.
                    return (Bitmap)bitmap.Clone();
                }
                finally
                {
                    NativeMethods.ocr_free_image_result(resultPtr);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OCREngineInterop] Native Exception in ReplaceText: {ex.Message}");
                return null;
            }
        }

        // -- Bitmap helpers -------------------------------------------------

        /// <summary>
        /// Convert a GDI+ <see cref="Bitmap"/> (ARGB) to a raw RGBA byte
        /// array suitable for the native C API.
        /// </summary>
        /// <param name="bitmap">Source bitmap (32 bpp).</param>
        /// <returns>
        /// A tuple of (RGBA pixels, width, height).
        /// </returns>
        private static (byte[] Pixels, int Width, int Height) BitmapToRgba(Bitmap bitmap)
        {
            int width  = bitmap.Width;
            int height = bitmap.Height;

            var rect = new Rectangle(0, 0, width, height);
            BitmapData data = bitmap.LockBits(
                rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);

            try
            {
                int stride     = Math.Abs(data.Stride);
                int pixelBytes = width * 4;
                byte[] rgba    = new byte[width * height * 4];

                unsafe
                {
                    byte* src = (byte*)data.Scan0;

                    for (int y = 0; y < height; y++)
                    {
                        byte* row = src + y * stride;
                        int dstOffset = y * pixelBytes;

                        for (int x = 0; x < width; x++)
                        {
                            int srcIdx = x * 4;
                            int dstIdx = dstOffset + x * 4;

                            // GDI+ ARGB layout (in memory): B G R A
                            // Target RGBA layout:           R G B A
                            byte b = row[srcIdx + 0];
                            byte g = row[srcIdx + 1];
                            byte r = row[srcIdx + 2];
                            byte a = row[srcIdx + 3];

                            rgba[dstIdx + 0] = r;
                            rgba[dstIdx + 1] = g;
                            rgba[dstIdx + 2] = b;
                            rgba[dstIdx + 3] = a;
                        }
                    }
                }

                return (rgba, width, height);
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
        }

        /// <summary>
        /// Parse a PPTX file and return its slides and layers JSON string.
        /// </summary>
        /// <param name="pptxPath">The absolute path to the PPTX file.</param>
        /// <returns>A JSON string containing the slide layers, or null on failure.</returns>
        public string? ParsePptx(string pptxPath)
        {
            ThrowIfDisposed();
            if (string.IsNullOrEmpty(pptxPath))
                throw new ArgumentException("Path cannot be null or empty", nameof(pptxPath));

            IntPtr jsonPtr = NativeMethods.ocr_parse_pptx(_engineHandle, pptxPath);
            if (jsonPtr == IntPtr.Zero)
                return null;

            try
            {
                return Marshal.PtrToStringAnsi(jsonPtr);
            }
            finally
            {
                NativeMethods.ocr_free_string(jsonPtr);
            }
        }

        /// <summary>
        /// Replace the image content of a specific image layer.
        /// </summary>
        /// <param name="layerId">The unique layer identifier.</param>
        /// <param name="newImage">The replacement image.</param>
        /// <returns>True on success, false on failure.</returns>
        public bool CanvasReplaceLayerImage(string layerId, Bitmap newImage)
        {
            ThrowIfDisposed();
            if (string.IsNullOrEmpty(layerId))
                throw new ArgumentException("Layer ID cannot be null or empty", nameof(layerId));
            if (newImage == null)
                throw new ArgumentNullException(nameof(newImage));

            var (pixels, width, height) = BitmapToRgba(newImage);
            int result = NativeMethods.ocr_canvas_replace_layer_image(_engineHandle, layerId, pixels, width, height);
            return result == 1;
        }

        /// <summary>
        /// Save the current document to the SQLite history.
        /// </summary>
        public static bool SaveDraftToHistory(string docId, string jsonData, string title, string previewImagePath)
        {
            try
            {
                int result = NativeMethods.ocr_history_save_document(docId, jsonData, title, previewImagePath);
                return result == 1;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[OCREngineInterop] Failed to save history: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Pre-process image using GDI+ ColorMatrix to simulate Apple Vision contrast and binarization.
        /// </summary>
        public static Bitmap PreprocessImage(Bitmap source)
        {
            if (source == null) return null;
            
            Bitmap result = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(result))
            {
                // Increase contrast by 1.5x, equivalent to CIColorControls.contrast = 1.5
                float contrast = 1.5f;
                float t = (1.0f - contrast) / 2.0f;
                
                ColorMatrix cm = new ColorMatrix(new float[][] {
                    new float[] {contrast, 0, 0, 0, 0},
                    new float[] {0, contrast, 0, 0, 0},
                    new float[] {0, 0, contrast, 0, 0},
                    new float[] {0, 0, 0, 1, 0},
                    new float[] {t, t, t, 0, 1}
                });
                
                using (ImageAttributes ia = new ImageAttributes())
                {
                    ia.SetColorMatrix(cm, ColorMatrixFlag.Default, ColorAdjustType.Bitmap);
                    g.DrawImage(source, new Rectangle(0, 0, source.Width, source.Height), 
                                0, 0, source.Width, source.Height, GraphicsUnit.Pixel, ia);
                }
            }
            return result;
        }

        // -- IDisposable implementation -------------------------------------

        /// <inheritdoc/>
        public void Dispose()
        {
            Dispose(disposing: true);
            GC.SuppressFinalize(this);
        }

        /// <summary>
        /// Release the unmanaged engine handle.
        /// </summary>
        /// <param name="disposing">
        /// <c>true</c> when called from <see cref="Dispose()"/>;
        /// <c>false</c> when called from the finaliser.
        /// </param>
        private void Dispose(bool disposing)
        {
            if (_disposed)
                return;

            if (_engineHandle != IntPtr.Zero)
            {
                NativeMethods.ocr_engine_destroy(_engineHandle);
                _engineHandle = IntPtr.Zero;
            }

            _disposed = true;
        }

        /// <summary>
        /// Destructor / finaliser — releases the native handle if the caller
        /// forgot to call <see cref="Dispose()"/>.
        /// </summary>
        ~OCREngineInterop()
        {
            Dispose(disposing: false);
        }

        /// <summary>
        /// Throw <see cref="ObjectDisposedException"/> if the engine has
        /// been disposed.
        /// </summary>
        private void ThrowIfDisposed()
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(
                    nameof(OCREngineInterop),
                    "Cannot use the OCR engine after it has been disposed.");
            }
        }
    }
}
