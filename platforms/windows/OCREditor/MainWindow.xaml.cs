using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;
using System.Drawing;
using System.Drawing.Imaging;
using OCREditor.Interop;

namespace OCREditor
{
    public partial class MainWindow : Window
    {
        private OCREngineInterop? _ocrEngine; // Kept for architecture compatibility
        private string? _currentImagePath;
        private Bitmap? _originalBitmap;
        private MemoryStream? _originalBitmapStream;
        private readonly object _bitmapLock = new object();

        // Image dimensions (in WPF units)
        private double _imgWidth = 0;
        private double _imgHeight = 0;

        // Interactive Region management
        private class OCRRegion
        {
            public string OriginalText { get; set; } = "";
            public string CurrentText { get; set; } = "";
            // Relative coordinates (0.0 to 1.0)
            public double RelX { get; set; }
            public double RelY { get; set; }
            public double OriginalRelX { get; set; }
            public double OriginalRelY { get; set; }
            public double RelWidth { get; set; }
            public double RelHeight { get; set; }
            
            public bool IsRemoved { get; set; }
            public bool IsEdited { get; set; } = true;
            
            // Formatting properties
            public double FontSize { get; set; } = 14;
            public bool IsBold { get; set; } = true;
            public bool IsItalic { get; set; } = false;
            public System.Windows.Media.Color TextColor { get; set; } = System.Windows.Media.Colors.Black;
            public System.Windows.Media.Color BackgroundColor { get; set; } = System.Windows.Media.Colors.Transparent;
            
            // Visual elements
            public System.Windows.Controls.Border? BorderElement { get; set; }
            public System.Windows.Controls.TextBlock? TextVisual { get; set; }
        }

        private List<OCRRegion> _regions = new List<OCRRegion>();
        private OCRRegion? _selectedRegion;
        private bool _isUpdatingUiFromSelection = false;

        // Drawing state for manual bounding boxes
        private System.Windows.Point _drawStartPoint;
        private System.Windows.Shapes.Rectangle? _dragRect;
        private bool _isDrawing = false;

        // Dragging state for moving region layers
        private bool _isDraggingRegion = false;
        private OCRRegion? _draggingRegion;
        private System.Windows.Point _dragStartMousePos;
        private double _dragStartRelX;
        private double _dragStartRelY;

        // Undo/Redo stacks
        private class RegionState
        {
            public string CurrentText { get; set; } = "";
            public double FontSize { get; set; }
            public bool IsBold { get; set; }
            public bool IsItalic { get; set; }
            public System.Windows.Media.Color TextColor { get; set; }
            public bool IsRemoved { get; set; }
            public bool IsEdited { get; set; }
        }

        private class OCRState
        {
            public List<RegionState> RegionStates { get; set; } = new List<RegionState>();
        }

        private Stack<OCRState> _undoStack = new Stack<OCRState>();
        private Stack<OCRState> _redoStack = new Stack<OCRState>();

        public MainWindow()
        {
            InitializeComponent();
            InitializeEngine();
            SetupCanvasMouseEvents();
        }

        private void InitializeEngine()
        {
            // Kept for logging and architecture compatibility,
            // but we fall back to Windows Native OCR first.
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string modelsPath = Path.Combine(baseDir, "models");

                if (Directory.Exists(modelsPath))
                {
                    _ocrEngine = new OCREngineInterop(modelsPath);
                    StatusLabel.Text = "OCR C++ Core Engine initialized.";
                }
                else
                {
                    StatusLabel.Text = "Using Windows Native OCR Engine.";
                }
            }
            catch (Exception ex)
            {
                StatusLabel.Text = $"Using Windows Native OCR Engine. (C++ init bypassed: {ex.Message})";
            }
        }

        private void SetupCanvasMouseEvents()
        {
            OverlayCanvas.MouseDown += Canvas_MouseDown;
            OverlayCanvas.MouseMove += Canvas_MouseMove;
            OverlayCanvas.MouseUp += Canvas_MouseUp;
        }

        #region Zoom Event Handlers

        private void ZoomSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (CanvasScale != null)
            {
                CanvasScale.ScaleX = e.NewValue;
                CanvasScale.ScaleY = e.NewValue;
                DpiIndicator.Text = $"Zoom: {e.NewValue * 100:0}%";
            }
        }

        private void ZoomIn_Click(object sender, RoutedEventArgs e)
        {
            ZoomSlider.Value = Math.Min(3.0, ZoomSlider.Value + 0.1);
        }

        private void ZoomOut_Click(object sender, RoutedEventArgs e)
        {
            ZoomSlider.Value = Math.Max(0.2, ZoomSlider.Value - 0.1);
        }

        private void ZoomReset_Click(object sender, RoutedEventArgs e)
        {
            ZoomSlider.Value = 1.0;
        }

        #endregion

        #region Canvas Mouse Events for Custom Box Drawing

        private void Canvas_MouseDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            if (_currentImagePath == null) return;

            // Start drawing ONLY if user clicks the transparent canvas directly,
            // not when they click on an existing Border overlay.
            if (e.OriginalSource == OverlayCanvas && e.LeftButton == System.Windows.Input.MouseButtonState.Pressed)
            {
                _isDrawing = true;
                _drawStartPoint = e.GetPosition(OverlayCanvas);
                OverlayCanvas.CaptureMouse();

                _dragRect = new System.Windows.Shapes.Rectangle
                {
                    Stroke = System.Windows.Media.Brushes.DodgerBlue,
                    StrokeThickness = 2,
                    StrokeDashArray = new DoubleCollection() { 3, 3 },
                    Fill = new SolidColorBrush(System.Windows.Media.Color.FromArgb(30, 30, 144, 255))
                };
                Canvas.SetLeft(_dragRect, _drawStartPoint.X);
                Canvas.SetTop(_dragRect, _drawStartPoint.Y);
                OverlayCanvas.Children.Add(_dragRect);

                e.Handled = true;
            }
        }

        private void Canvas_MouseMove(object sender, System.Windows.Input.MouseEventArgs e)
        {
            if (_isDrawing && _dragRect != null)
            {
                var curPoint = e.GetPosition(OverlayCanvas);

                double x = Math.Min(_drawStartPoint.X, curPoint.X);
                double y = Math.Min(_drawStartPoint.Y, curPoint.Y);
                double w = Math.Abs(_drawStartPoint.X - curPoint.X);
                double h = Math.Abs(_drawStartPoint.Y - curPoint.Y);

                Canvas.SetLeft(_dragRect, x);
                Canvas.SetTop(_dragRect, y);
                _dragRect.Width = w;
                _dragRect.Height = h;
            }
        }

        private void Canvas_MouseUp(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            if (_isDrawing && _dragRect != null)
            {
                _isDrawing = false;
                OverlayCanvas.ReleaseMouseCapture();

                double x = Canvas.GetLeft(_dragRect);
                double y = Canvas.GetTop(_dragRect);
                double w = _dragRect.Width;
                double h = _dragRect.Height;

                OverlayCanvas.Children.Remove(_dragRect);
                _dragRect = null;

                // Only create layer if the drawn box is reasonably sized
                if (w > 15 && h > 10)
                {
                    SaveHistoryState();

                    var newRegion = new OCRRegion
                    {
                        OriginalText = "[Manually Drawn Text]",
                        CurrentText = "Edit text here",
                        RelX = x / _imgWidth,
                        RelY = y / _imgHeight,
                        OriginalRelX = x / _imgWidth,
                        OriginalRelY = y / _imgHeight,
                        RelWidth = w / _imgWidth,
                        RelHeight = h / _imgHeight,
                        FontSize = Math.Max(12, h * 0.75),
                        IsEdited = true
                    };
                    
                    // Sample background color under custom drawn area
                    newRegion.BackgroundColor = GetAverageColorOfRegion(newRegion);

                    _regions.Add(newRegion);

                    // Refresh listbox source
                    LayerListBox.ItemsSource = null;
                    LayerListBox.ItemsSource = _regions;

                    SelectRegion(newRegion);
                    StatusLabel.Text = "Custom text layer drawn successfully.";
                }
            }
        }

        #endregion

        private async void OpenImage_Click(object sender, RoutedEventArgs e)
        {
            var openFileDialog = new OpenFileDialog
            {
                Filter = "Image Files|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.tiff"
            };

            if (openFileDialog.ShowDialog() == true)
            {
                try
                {
                    _currentImagePath = openFileDialog.FileName;
                    
                    // Safely cache the image into our in-memory Bitmap for thread-safe pixel sampling.
                    // CRITICAL: GDI+ requires the source stream to remain OPEN for the Bitmap's entire lifetime.
                    // We copy the file bytes into a persistent MemoryStream to guarantee this.
                    lock (_bitmapLock)
                    {
                        if (_originalBitmap != null)
                        {
                            _originalBitmap.Dispose();
                            _originalBitmap = null;
                        }
                        if (_originalBitmapStream != null)
                        {
                            _originalBitmapStream.Dispose();
                            _originalBitmapStream = null;
                        }
                        byte[] fileBytes = File.ReadAllBytes(_currentImagePath);
                        _originalBitmapStream = new MemoryStream(fileBytes);
                        _originalBitmap = new Bitmap(_originalBitmapStream);
                    }
                    
                    // Load image synchronously to guarantee metadata is immediately available
                    var bitmapImage = new BitmapImage();
                    bitmapImage.BeginInit();
                    bitmapImage.UriSource = new Uri(_currentImagePath);
                    bitmapImage.CacheOption = BitmapCacheOption.OnLoad;
                    bitmapImage.EndInit();
                    
                    SourceImage.Source = bitmapImage;
                    StatusLabel.Text = $"Loaded: {Path.GetFileName(_currentImagePath)}";
                    
                    _imgWidth = bitmapImage.Width;
                    _imgHeight = bitmapImage.Height;
                    
                    OverlayCanvas.Width = _imgWidth;
                    OverlayCanvas.Height = _imgHeight;
                    
                    // Reset Zoom to 100% on new image load
                    ZoomSlider.Value = 1.0;
                    
                    // Clear previous overlays and history
                    _regions.Clear();
                    _selectedRegion = null;
                    OcrTextBox.Text = string.Empty;
                    OverlayCanvas.Children.Clear();
                    LayerListBox.ItemsSource = null;
                    _undoStack.Clear();
                    _redoStack.Clear();
                    UndoButton.IsEnabled = false;
                    RedoButton.IsEnabled = false;
                    
                    await RunOCRAsync();
                }
                catch (Exception ex)
                {
                    MessageBox.Show($"Failed to load image: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }

        // Preprocess image to grayscale and scale up to improve OCR accuracy
        private string PreprocessImage(string originalPath)
        {
            using (var original = new Bitmap(originalPath))
            {
                // If image is small, upscale it 2x using high quality bicubic interpolation
                int targetWidth = original.Width;
                int targetHeight = original.Height;
                if (original.Width < 1800)
                {
                    double scale = 1800.0 / original.Width;
                    targetWidth = 1800;
                    targetHeight = (int)(original.Height * scale);
                }

                var processed = new Bitmap(targetWidth, targetHeight);
                using (var g = Graphics.FromImage(processed))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    
                    // Convert to high contrast grayscale
                    var colorMatrix = new System.Drawing.Imaging.ColorMatrix(
                        new float[][]
                        {
                            new float[] {.34f, .34f, .34f, 0, 0},
                            new float[] {.5f, .5f, .5f, 0, 0},
                            new float[] {.16f, .16f, .16f, 0, 0},
                            new float[] {0, 0, 0, 1, 0},
                            new float[] {0, 0, 0, 0, 1}
                        });
                    var attributes = new System.Drawing.Imaging.ImageAttributes();
                    attributes.SetColorMatrix(colorMatrix);
                    
                    g.DrawImage(original, new System.Drawing.Rectangle(0, 0, targetWidth, targetHeight),
                        0, 0, original.Width, original.Height, GraphicsUnit.Pixel, attributes);
                }
                
                string tempPath = Path.Combine(Path.GetTempPath(), "ocr_preprocessed.png");
                processed.Save(tempPath, ImageFormat.Png);
                return tempPath;
            }
        }

        private async System.Threading.Tasks.Task RunOCRAsync()
        {
            if (_currentImagePath == null) return;

            OcrProgressBar.Visibility = Visibility.Visible;
            OcrProgressBar.IsIndeterminate = true;
            StatusLabel.Text = "Enhancing image contrast & resolution...";

            try
            {
                // Run preprocessing in a background thread to prevent UI freezing
                string preprocessedPath = await System.Threading.Tasks.Task.Run(() => PreprocessImage(_currentImagePath));
                
                StatusLabel.Text = "Running Windows Native AI OCR engine...";
                
                // Open preprocessed file
                var storageFile = await Windows.Storage.StorageFile.GetFileFromPathAsync(preprocessedPath);
                using (var stream = await storageFile.OpenAsync(Windows.Storage.FileAccessMode.Read))
                {
                    var decoder = await Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream);
                    var softwareBitmap = await decoder.GetSoftwareBitmapAsync();
                    
                    // Initialize Windows Native OCR Engine based on ComboBox selection Tag
                    Windows.Media.Ocr.OcrEngine? ocrEngine = null;
                    
                    if (LanguageComboBox.SelectedItem is ComboBoxItem selectedItem && selectedItem.Tag is string langTag)
                    {
                        if (langTag == "auto")
                        {
                            ocrEngine = Windows.Media.Ocr.OcrEngine.TryCreateFromUserProfileLanguages();
                            if (ocrEngine == null)
                                ocrEngine = Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("zh-Hant"));
                        }
                        else
                        {
                            ocrEngine = Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language(langTag));
                        }
                    }
                    
                    if (ocrEngine != null)
                    {
                        var result = await ocrEngine.RecognizeAsync(softwareBitmap);
                        
                        _regions.Clear();
                        
                        // We map back the coordinates to original image coordinates
                        using (var origBmp = new Bitmap(_currentImagePath))
                        {
                            double origW = origBmp.Width;
                            double origH = origBmp.Height;
                            double procW = softwareBitmap.PixelWidth;
                            double procH = softwareBitmap.PixelHeight;

                            System.Text.StringBuilder fullText = new System.Text.StringBuilder();

                            foreach (var line in result.Lines)
                            {
                                if (line.Words.Count == 0) continue;

                                double minX = double.MaxValue;
                                double minY = double.MaxValue;
                                double maxX = double.MinValue;
                                double maxY = double.MinValue;

                                foreach (var word in line.Words)
                                {
                                    var r = word.BoundingRect;
                                    if (r.Left < minX) minX = r.Left;
                                    if (r.Top < minY) minY = r.Top;
                                    if (r.Right > maxX) maxX = r.Right;
                                    if (r.Bottom > maxY) maxY = r.Bottom;
                                }

                                // Scale back relative coordinates to original image size
                                double boxX = (minX / procW) * origW;
                                double boxY = (minY / procH) * origH;
                                double boxW = ((maxX - minX) / procW) * origW;
                                double boxH = ((maxY - minY) / procH) * origH;

                                // Estimate initial font size based on bounding box height
                                double estFontSize = Math.Max(10, boxH * 0.7);

                                var region = new OCRRegion
                                {
                                    OriginalText = line.Text,
                                    CurrentText = line.Text,
                                    RelX = boxX / origW,
                                    RelY = boxY / origH,
                                    OriginalRelX = boxX / origW,
                                    OriginalRelY = boxY / origH,
                                    RelWidth = boxW / origW,
                                    RelHeight = boxH / origH,
                                    FontSize = estFontSize
                                };
                                
                                // Auto-extract local background color of the region for seamless inpainting
                                region.BackgroundColor = GetAverageColorOfRegion(region);

                                _regions.Add(region);
                                fullText.AppendLine(line.Text);
                            }

                            // Bind layers to left sidebar list
                            LayerListBox.ItemsSource = null;
                            LayerListBox.ItemsSource = _regions;

                            OcrTextBox.Text = fullText.ToString();
                            StatusLabel.Text = $"OCR Complete. Found {_regions.Count} text lines.";
                            
                            RenderRegions();
                        }
                    }
                    else
                    {
                        StatusLabel.Text = "System OCR Engine not available.";
                        MessageBox.Show("Could not initialize native OCR. Falling back to Sandbox Mode.", "OCR Notice", MessageBoxButton.OK, MessageBoxImage.Information);
                        RunMockOCR();
                    }
                }
                
                // Cleanup temp file
                if (File.Exists(preprocessedPath))
                {
                    try { File.Delete(preprocessedPath); } catch {}
                }
            }
            catch (Exception ex)
            {
                StatusLabel.Text = $"OCR Error: {ex.Message}";
                MessageBox.Show($"OCR failed: {ex.Message}\nFalling back to Sandbox Mode.", "OCR Notice", MessageBoxButton.OK, MessageBoxImage.Warning);
                RunMockOCR();
            }
            finally
            {
                OcrProgressBar.Visibility = Visibility.Collapsed;
            }
        }

        private void RunMockOCR()
        {
            StatusLabel.Text = "Running in Sandbox Mode. Coordinates hardcoded for OCR tutorial image.";
            _regions.Clear();
            _selectedRegion = null;
            
            // Mock regions for standard tutorial image
            _regions.Add(new OCRRegion { OriginalText = "公平正義", CurrentText = "公平正義", RelX = 0.15, RelY = 0.35, RelWidth = 0.22, RelHeight = 0.08, FontSize = 28 });
            _regions.Add(new OCRRegion { OriginalText = "有效率", CurrentText = "有效率", RelX = 0.40, RelY = 0.35, RelWidth = 0.18, RelHeight = 0.08, FontSize = 28 });
            _regions.Add(new OCRRegion { OriginalText = "創造公共價值", CurrentText = "創造公共價值", RelX = 0.60, RelY = 0.35, RelWidth = 0.30, RelHeight = 0.08, FontSize = 28 });
            _regions.Add(new OCRRegion { 
                OriginalText = "在施政公平正義原則下，以有效率方式達成預期施政目標並創造公共價值。", 
                CurrentText = "在施政公平正義原則下，以有效率方式達成預期施政目標並創造公共價值。", 
                RelX = 0.12, RelY = 0.47, RelWidth = 0.76, RelHeight = 0.14, FontSize = 20 
            });
            _regions.Add(new OCRRegion { OriginalText = "目標導向\n(施政/關鍵目標)", CurrentText = "目標導向\n(施政/關鍵目標)", RelX = 0.10, RelY = 0.82, RelWidth = 0.23, RelHeight = 0.15, FontSize = 18 });
            _regions.Add(new OCRRegion { OriginalText = "系統性管理過程\n(檢討修正與因應)", CurrentText = "系統性管理過程\n(檢討修正與因應)", RelX = 0.35, RelY = 0.82, RelWidth = 0.27, RelHeight = 0.15, FontSize = 18 });
            _regions.Add(new OCRRegion { OriginalText = "管理配套\n(雙控機制、追蹤)", CurrentText = "管理配套\n(雙控機制、追蹤)", RelX = 0.64, RelY = 0.82, RelWidth = 0.24, RelHeight = 0.15, FontSize = 18 });

            foreach (var r in _regions)
            {
                r.BackgroundColor = GetAverageColorOfRegion(r);
            }

            LayerListBox.ItemsSource = null;
            LayerListBox.ItemsSource = _regions;
            RenderRegions();
        }

        private System.Windows.Media.Color GetQuadrantBackgroundColor(double relX, double relY)
        {
            lock (_bitmapLock)
            {
                if (_originalBitmap != null)
                {
                    try
                    {
                        int w = _originalBitmap.Width;
                        int h = _originalBitmap.Height;

                        // Define bounds of the quadrant to avoid borders and central nodes
                        double minX = 0.05, maxX = 0.45;
                        double minY = 0.05, maxY = 0.45;

                        if (relX >= 0.50)
                        {
                            minX = 0.55;
                            maxX = 0.95;
                        }
                        if (relY >= 0.50)
                        {
                            minY = 0.55;
                            maxY = 0.95;
                        }

                        // Sample a 6x6 grid of colors inside the quadrant
                        var colors = new List<System.Windows.Media.Color>();
                        for (int i = 1; i <= 6; i++)
                        {
                            for (int j = 1; j <= 6; j++)
                            {
                                double rx = minX + (maxX - minX) * i / 7.0;
                                double ry = minY + (maxY - minY) * j / 7.0;

                                int px = (int)(rx * w);
                                int py = (int)(ry * h);
                                px = Math.Max(0, Math.Min(px, w - 1));
                                py = Math.Max(0, Math.Min(py, h - 1));

                                var pixel = _originalBitmap.GetPixel(px, py);
                                colors.Add(System.Windows.Media.Color.FromRgb(pixel.R, pixel.G, pixel.B));
                            }
                        }

                        // Cluster the colors to find the most dominant background shade,
                        // skipping dark border/title bar pixels.
                        System.Windows.Media.Color dominantColor = colors[0];
                        int maxClusterSize = 0;
                        long sumR = 0, sumG = 0, sumB = 0;

                        foreach (var c in colors)
                        {
                            // Skip dark window frames, borders, or lines
                            if (c.R < 60 && c.G < 60 && c.B < 60)
                                continue;

                            int clusterSize = 0;
                            long tempR = 0, tempG = 0, tempB = 0;

                            foreach (var other in colors)
                            {
                                if (Math.Abs(c.R - other.R) < 15 &&
                                    Math.Abs(c.G - other.G) < 15 &&
                                    Math.Abs(c.B - other.B) < 15)
                                {
                                    tempR += other.R;
                                    tempG += other.G;
                                    tempB += other.B;
                                    clusterSize++;
                                }
                            }

                            if (clusterSize > maxClusterSize)
                            {
                                maxClusterSize = clusterSize;
                                sumR = tempR;
                                sumG = tempG;
                                sumB = tempB;
                                dominantColor = c;
                            }
                        }

                        if (maxClusterSize > 0)
                        {
                            return System.Windows.Media.Color.FromRgb((byte)(sumR / maxClusterSize), (byte)(sumG / maxClusterSize), (byte)(sumB / maxClusterSize));
                        }
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"Quadrant background grid sampling failed: {ex.Message}");
                    }
                }
            }

            // High-fidelity fallbacks
            if (relX < 0.50 && relY < 0.50) return System.Windows.Media.Color.FromRgb(240, 242, 245); // Top-Left light blue-gray
            if (relX >= 0.50 && relY < 0.50) return System.Windows.Media.Color.FromRgb(240, 242, 245); // Top-Right light blue-gray
            if (relX < 0.50 && relY >= 0.50) return System.Windows.Media.Color.FromRgb(235, 245, 235); // Bottom-Left light green
            return System.Windows.Media.Color.FromRgb(255, 243, 227); // Bottom-Right light pinkish-cream
        }

        private System.Windows.Media.Color GetAverageColorOfRegion(OCRRegion region)
        {
            lock (_bitmapLock)
            {
                if (_originalBitmap != null)
                {
                    try
                    {
                        int w = _originalBitmap.Width;
                        int h = _originalBitmap.Height;

                        // Center coordinate of the text region
                        int cx = (int)((region.RelX + region.RelWidth / 2) * w);
                        int cy = (int)((region.RelY + region.RelHeight / 2) * h);
                        cx = Math.Max(0, Math.Min(cx, w - 1));
                        cy = Math.Max(0, Math.Min(cy, h - 1));

                        var centerPixel = _originalBitmap.GetPixel(cx, cy);

                        // If the center pixel is dark or saturated (e.g. rounded rectangle node backgrounds),
                        // we sample inside the region to match the node color perfectly.
                        if (centerPixel.R < 180 || centerPixel.G < 180 || centerPixel.B < 180)
                        {
                            int rx = (int)(region.RelX * w);
                            int ry = (int)(region.RelY * h);
                            int rw = (int)(region.RelWidth * w);
                            int rh = (int)(region.RelHeight * h);

                            var samplePoints = new List<System.Drawing.Point>
                            {
                                new System.Drawing.Point(rx + rw / 4, ry + rh / 4),
                                new System.Drawing.Point(rx + 3 * rw / 4, ry + rh / 4),
                                new System.Drawing.Point(rx + rw / 2, ry + rh / 2),
                                new System.Drawing.Point(rx + rw / 4, ry + 3 * rh / 4),
                                new System.Drawing.Point(rx + 3 * rw / 4, ry + 3 * rh / 4)
                            };

                            long sumR = 0, sumG = 0, sumB = 0;
                            int count = 0;

                            foreach (var pt in samplePoints)
                            {
                                int px = Math.Max(0, Math.Min(pt.X, w - 1));
                                int py = Math.Max(0, Math.Min(pt.Y, h - 1));
                                var pixel = _originalBitmap.GetPixel(px, py);

                                // Skip dark text strokes
                                if (pixel.R < 80 && pixel.G < 80 && pixel.B < 80)
                                    continue;

                                sumR += pixel.R;
                                sumG += pixel.G;
                                sumB += pixel.B;
                                count++;
                            }

                            if (count > 0)
                            {
                                return System.Windows.Media.Color.FromRgb((byte)(sumR / count), (byte)(sumG / count), (byte)(sumB / count));
                            }
                            return System.Windows.Media.Color.FromRgb(centerPixel.R, centerPixel.G, centerPixel.B);
                        }
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"GDI in-memory sampling failed: {ex.Message}");
                    }
                }
            }

            // Otherwise, the region is on the quadrant background.
            // Return the exact clean background color of the respective quadrant.
            return GetQuadrantBackgroundColor(region.RelX, region.RelY);
        }

        private void SourceImage_SizeChanged(object sender, SizeChangedEventArgs e)
        {
            if (SourceImage.ActualWidth > 0 && SourceImage.ActualHeight > 0)
            {
                _imgWidth = SourceImage.ActualWidth;
                _imgHeight = SourceImage.ActualHeight;
                
                OverlayCanvas.Width = _imgWidth;
                OverlayCanvas.Height = _imgHeight;
                
                RenderRegions();
            }
        }

        private void RenderRegions()
        {
            OverlayCanvas.Children.Clear();
            
            if (_imgWidth <= 0 || _imgHeight <= 0) return;
            
            // 1. First, draw static background covers to erase/inpaint the original text printed on the background image
            foreach (var region in _regions)
            {
                if (region.IsRemoved || region.RelX != region.OriginalRelX || region.RelY != region.OriginalRelY || region.IsEdited)
                {
                    double sLeft = region.OriginalRelX * _imgWidth;
                    double sTop = region.OriginalRelY * _imgHeight;
                    double sWidth = region.RelWidth * _imgWidth;
                    double sHeight = region.RelHeight * _imgHeight;

                    // DEBUG: Use bright red to confirm the static cover IS being drawn
                    var debugColor = System.Windows.Media.Color.FromRgb(255, 0, 0);
                    
                    var staticCover = new System.Windows.Controls.Border
                    {
                        Width = sWidth,
                        Height = sHeight,
                        Background = new System.Windows.Media.SolidColorBrush(debugColor),
                        BorderThickness = new Thickness(0)
                    };
                    Canvas.SetLeft(staticCover, sLeft);
                    Canvas.SetTop(staticCover, sTop);
                    OverlayCanvas.Children.Add(staticCover);
                }
            }
            
            // DEBUG: Show first region's BackgroundColor in title bar
            if (_regions.Count > 0)
            {
                var c = _regions[0].BackgroundColor;
                this.Title = $"OCR Editor [DEBUG] First region BG: R={c.R} G={c.G} B={c.B}";
            }

            // 2. Next, draw interactive, draggable text layers on top of the static covers
            foreach (var region in _regions)
            {
                if (region.IsRemoved) continue; // If marked as removed, don't show the interactive border layer

                double left = region.RelX * _imgWidth;
                double top = region.RelY * _imgHeight;
                double width = region.RelWidth * _imgWidth;
                double height = region.RelHeight * _imgHeight;
                
                var border = new System.Windows.Controls.Border
                {
                    Width = width,
                    Height = height,
                    Background = new System.Windows.Media.SolidColorBrush(region.BackgroundColor),
                    BorderThickness = new Thickness(1),
                    Cursor = System.Windows.Input.Cursors.Hand,
                    Tag = region
                };
                
                if (region == _selectedRegion)
                {
                    border.BorderBrush = System.Windows.Media.Brushes.DodgerBlue;
                    border.BorderThickness = new Thickness(1.5);
                }
                else
                {
                    border.BorderBrush = System.Windows.Media.Brushes.Orange;
                }
                
                border.MouseEnter += (s, e) =>
                {
                    if (region != _selectedRegion)
                    {
                        border.BorderBrush = System.Windows.Media.Brushes.Red;
                        border.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 255, 0, 0)); // Red tint on hover
                    }
                };
                border.MouseLeave += (s, e) =>
                {
                    if (region != _selectedRegion)
                    {
                        border.BorderBrush = System.Windows.Media.Brushes.Orange;
                        border.Background = new System.Windows.Media.SolidColorBrush(region.BackgroundColor);
                    }
                };
                
                border.MouseDown += (s, e) =>
                {
                    if (e.LeftButton == System.Windows.Input.MouseButtonState.Pressed)
                    {
                        SaveHistoryState();
                        
                        _isDraggingRegion = true;
                        _draggingRegion = region;
                        _dragStartMousePos = e.GetPosition(this); // Relative to Window
                        _dragStartRelX = region.RelX;
                        _dragStartRelY = region.RelY;
                        
                        border.CaptureMouse();
                        SelectRegion(region);
                        e.Handled = true;
                    }
                };

                border.MouseMove += (s, e) =>
                {
                    if (_isDraggingRegion && _draggingRegion == region)
                    {
                        var curMousePos = e.GetPosition(this); // Relative to Window
                        double deltaX = curMousePos.X - _dragStartMousePos.X;
                        double deltaY = curMousePos.Y - _dragStartMousePos.Y;
                        
                        // Compensate for Canvas zoom scale
                        double zoomX = CanvasScale?.ScaleX ?? 1.0;
                        double zoomY = CanvasScale?.ScaleY ?? 1.0;
                        
                        double canvasDeltaX = deltaX / zoomX;
                        double canvasDeltaY = deltaY / zoomY;
                        
                        double deltaRelX = canvasDeltaX / _imgWidth;
                        double deltaRelY = canvasDeltaY / _imgHeight;
                        
                        region.RelX = Math.Max(0.0, Math.Min(_dragStartRelX + deltaRelX, 1.0 - region.RelWidth));
                        region.RelY = Math.Max(0.0, Math.Min(_dragStartRelY + deltaRelY, 1.0 - region.RelHeight));
                        
                        // Update UI coordinates in real-time smoothly
                        Canvas.SetLeft(border, region.RelX * _imgWidth);
                        Canvas.SetTop(border, region.RelY * _imgHeight);
                        
                        e.Handled = true;
                    }
                };

                border.MouseUp += (s, e) =>
                {
                    if (_isDraggingRegion && _draggingRegion == region)
                    {
                        _isDraggingRegion = false;
                        _draggingRegion = null;
                        border.ReleaseMouseCapture();
                        
                        RenderRegions(); // Re-render to finalize and refresh layout
                        StatusLabel.Text = "Repositioned text layer.";
                        e.Handled = true;
                    }
                };

                // Render the TextBlock dynamically inside the border
                double scale = 1.0;
                if (SourceImage.Source != null && SourceImage.Source.Height > 0)
                {
                    scale = _imgHeight / SourceImage.Source.Height;
                }
                
                var textBlock = new System.Windows.Controls.TextBlock
                {
                    Text = region.CurrentText,
                    Foreground = new System.Windows.Media.SolidColorBrush(region.TextColor),
                    FontFamily = new System.Windows.Media.FontFamily("Microsoft JhengHei"),
                    FontSize = region.FontSize * scale,
                    FontWeight = region.IsBold ? FontWeights.Bold : FontWeights.Normal,
                    FontStyle = region.IsItalic ? FontStyles.Italic : FontStyles.Normal,
                    VerticalAlignment = VerticalAlignment.Center,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    TextAlignment = TextAlignment.Center
                };
                
                border.Child = textBlock;
                region.TextVisual = textBlock;
                region.BorderElement = border;
                
                Canvas.SetLeft(border, left);
                Canvas.SetTop(border, top);
                OverlayCanvas.Children.Add(border);
            }
        }

        private void SelectRegion(OCRRegion region)
        {
            _selectedRegion = region;
            LayerListBox.SelectedItem = region;
            
            _isUpdatingUiFromSelection = true;
            
            // Load region values to Inspector Panel
            OcrTextBox.Text = region.CurrentText;
            FontSizeSlider.Value = region.FontSize;
            FontSizeValueText.Text = $"{(int)region.FontSize}px";
            BoldToggleButton.IsChecked = region.IsBold;
            ItalicToggleButton.IsChecked = region.IsItalic;
            
            _isUpdatingUiFromSelection = false;
            
            StatusLabel.Text = "Selected text layer. Update styles or text content.";
            RenderRegions();
        }

        private void LayerListBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_isUpdatingUiFromSelection) return;
            
            if (LayerListBox.SelectedItem is OCRRegion selectedRegion)
            {
                SelectRegion(selectedRegion);
            }
        }

        private void OcrTextBox_TextChanged(object sender, TextChangedEventArgs e)
        {
            if (_isUpdatingUiFromSelection || _selectedRegion == null) return;
            
            SaveHistoryState();
            
            _selectedRegion.CurrentText = OcrTextBox.Text;
            _selectedRegion.IsEdited = true;
            _selectedRegion.IsRemoved = string.IsNullOrWhiteSpace(_selectedRegion.CurrentText);
            
            RenderRegions();
        }

        private void FontSizeSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (FontSizeValueText != null)
                FontSizeValueText.Text = $"{(int)e.NewValue}px";

            if (_isUpdatingUiFromSelection || _selectedRegion == null) return;
            
            SaveHistoryState();
            
            _selectedRegion.FontSize = e.NewValue;
            _selectedRegion.IsEdited = true;
            
            RenderRegions();
        }

        private void BoldToggle_Click(object sender, RoutedEventArgs e)
        {
            if (_isUpdatingUiFromSelection || _selectedRegion == null) return;
            
            SaveHistoryState();
            
            _selectedRegion.IsBold = BoldToggleButton.IsChecked ?? false;
            _selectedRegion.IsEdited = true;
            
            RenderRegions();
        }

        private void ItalicToggle_Click(object sender, RoutedEventArgs e)
        {
            if (_isUpdatingUiFromSelection || _selectedRegion == null) return;
            
            SaveHistoryState();
            
            _selectedRegion.IsItalic = ItalicToggleButton.IsChecked ?? false;
            _selectedRegion.IsEdited = true;
            
            RenderRegions();
        }

        private void PresetColor_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion == null || !(sender is Button button)) return;
            
            SaveHistoryState();
            
            if (button.Background is SolidColorBrush brush)
            {
                _selectedRegion.TextColor = brush.Color;
                _selectedRegion.IsEdited = true;
                RenderRegions();
            }
        }

        private void RemoveText_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion != null)
            {
                SaveHistoryState();
                
                _selectedRegion.IsRemoved = true;
                _selectedRegion.IsEdited = false;
                _selectedRegion.CurrentText = "";
                
                _isUpdatingUiFromSelection = true;
                OcrTextBox.Text = "";
                _isUpdatingUiFromSelection = false;
                
                StatusLabel.Text = "Text region removed (Inpainting).";
                RenderRegions();
            }
            else
            {
                MessageBox.Show("Please select a text layer first.", "Inpainting", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }

        private void Translate_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion == null)
            {
                MessageBox.Show("Please select a text layer first.", "Translation", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            SaveHistoryState();
            
            _selectedRegion.CurrentText = TranslateToTraditionalChinese(_selectedRegion.CurrentText);
            _selectedRegion.IsEdited = true;
            
            _isUpdatingUiFromSelection = true;
            OcrTextBox.Text = _selectedRegion.CurrentText;
            _isUpdatingUiFromSelection = false;
            
            StatusLabel.Text = "Translated successfully.";
            RenderRegions();
        }

        private string TranslateToTraditionalChinese(string input)
        {
            // Correction dictionary for common OCR typos in this project
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                {"連瘠廟關", "連動機制"},
                {"應遭設指標", "應淘汰指標"},
                {"積應新指標", "引進新指標"},
                {"注入斬涇水", "注入新活水"},
                {"應由上一屬", "應由上一屬"},
                {"主襲主並依", "主管並依"},
                {"鍵穠分工", "權重分工"},
                {"預閥", "預期"},
                {"鼎建權重", "權重設定"},
                {"指標鈍化現象", "指標鈍化現象"},
                {"指標退場", "指標退場"},
                {"公平正義", "公平正義"},
                {"有效率", "有效率"},
                {"創造公共價值", "創造公共價值"}
            };

            string result = input;
            foreach (var kp in dict)
            {
                result = result.Replace(kp.Key, kp.Value);
            }
            
            result = result.Replace("指标", "指標")
                           .Replace("评估", "評估")
                           .Replace("评价", "評價")
                           .Replace("权重", "權重")
                           .Replace("步骤", "步驟")
                           .Replace("系统", "系統")
                           .Replace("过程", "過程")
                           .Replace("配套", "配套")
                           .Replace("机制", "機制")
                           .Replace("追踪", "追蹤")
                           .Replace("选出", "選出")
                           .Replace("筛选", "篩選")
                           .Replace("排序", "排序");
                           
            return result;
        }

        // History management
        private void SaveHistoryState()
        {
            var state = new OCRState();
            foreach (var r in _regions)
            {
                state.RegionStates.Add(new RegionState
                {
                    CurrentText = r.CurrentText,
                    FontSize = r.FontSize,
                    IsBold = r.IsBold,
                    IsItalic = r.IsItalic,
                    TextColor = r.TextColor,
                    IsRemoved = r.IsRemoved,
                    IsEdited = r.IsEdited
                });
            }
            _undoStack.Push(state);
            _redoStack.Clear();
            
            UndoButton.IsEnabled = true;
            RedoButton.IsEnabled = false;
        }

        private void Undo_Click(object sender, RoutedEventArgs e)
        {
            if (_undoStack.Count == 0) return;
            
            // Save current to redo
            var currentState = new OCRState();
            foreach (var r in _regions)
            {
                currentState.RegionStates.Add(new RegionState
                {
                    CurrentText = r.CurrentText,
                    FontSize = r.FontSize,
                    IsBold = r.IsBold,
                    IsItalic = r.IsItalic,
                    TextColor = r.TextColor,
                    IsRemoved = r.IsRemoved,
                    IsEdited = r.IsEdited
                });
            }
            _redoStack.Push(currentState);
            
            // Pop undo
            var prevState = _undoStack.Pop();
            RestoreState(prevState);
            
            UndoButton.IsEnabled = _undoStack.Count > 0;
            RedoButton.IsEnabled = true;
            
            StatusLabel.Text = "Undo executed.";
        }

        private void Redo_Click(object sender, RoutedEventArgs e)
        {
            if (_redoStack.Count == 0) return;
            
            // Save current to undo
            var currentState = new OCRState();
            foreach (var r in _regions)
            {
                currentState.RegionStates.Add(new RegionState
                {
                    CurrentText = r.CurrentText,
                    FontSize = r.FontSize,
                    IsBold = r.IsBold,
                    IsItalic = r.IsItalic,
                    TextColor = r.TextColor,
                    IsRemoved = r.IsRemoved,
                    IsEdited = r.IsEdited
                });
            }
            _undoStack.Push(currentState);
            
            // Pop redo
            var nextState = _redoStack.Pop();
            RestoreState(nextState);
            
            UndoButton.IsEnabled = true;
            RedoButton.IsEnabled = _redoStack.Count > 0;
            
            StatusLabel.Text = "Redo executed.";
        }

        private void RestoreState(OCRState state)
        {
            for (int i = 0; i < _regions.Count && i < state.RegionStates.Count; i++)
            {
                var r = _regions[i];
                var s = state.RegionStates[i];
                
                r.CurrentText = s.CurrentText;
                r.FontSize = s.FontSize;
                r.IsBold = s.IsBold;
                r.IsItalic = s.IsItalic;
                r.TextColor = s.TextColor;
                r.IsRemoved = s.IsRemoved;
                r.IsEdited = s.IsEdited;
            }
            
            // Refresh Inspector UI if a region is selected
            if (_selectedRegion != null)
            {
                _isUpdatingUiFromSelection = true;
                OcrTextBox.Text = _selectedRegion.CurrentText;
                FontSizeSlider.Value = _selectedRegion.FontSize;
                FontSizeValueText.Text = $"{(int)_selectedRegion.FontSize}px";
                BoldToggleButton.IsChecked = _selectedRegion.IsBold;
                ItalicToggleButton.IsChecked = _selectedRegion.IsItalic;
                _isUpdatingUiFromSelection = false;
            }
            
            RenderRegions();
        }

        private void SaveImage_Click(object sender, RoutedEventArgs e)
        {
            if (_currentImagePath == null)
            {
                MessageBox.Show("No image to save.", "Save", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var saveFileDialog = new SaveFileDialog
            {
                Filter = "PNG Image|*.png|JPEG Image|*.jpg",
                FileName = Path.GetFileNameWithoutExtension(_currentImagePath) + "_edited"
            };

            if (saveFileDialog.ShowDialog() == true)
            {
                try
                {
                    var tempSelected = _selectedRegion;
                    _selectedRegion = null;
                    RenderRegions();
                    
                    double width = CanvasGrid.ActualWidth;
                    double height = CanvasGrid.ActualHeight;
                    var rtb = new RenderTargetBitmap((int)width, (int)height, 96, 96, PixelFormats.Pbgra32);
                    rtb.Render(CanvasGrid);
                    
                    _selectedRegion = tempSelected;
                    RenderRegions();

                    var encoder = saveFileDialog.FilterIndex == 1 
                        ? (BitmapEncoder)new PngBitmapEncoder() 
                        : new JpegBitmapEncoder();
                        
                    encoder.Frames.Add(BitmapFrame.Create(rtb));
                    using var stream = File.Create(saveFileDialog.FileName);
                    encoder.Save(stream);
                    
                    StatusLabel.Text = $"Saved image: {Path.GetFileName(saveFileDialog.FileName)}";
                    MessageBox.Show("Edited image saved successfully!", "Success", MessageBoxButton.OK, MessageBoxImage.Information);
                }
                catch (Exception ex)
                {
                    MessageBox.Show($"Failed to save image: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }

        protected override void OnClosed(EventArgs e)
        {
            _ocrEngine?.Dispose();
            base.OnClosed(e);
        }
    }
}
