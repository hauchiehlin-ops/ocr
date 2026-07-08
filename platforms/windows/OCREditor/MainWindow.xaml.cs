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
    public partial class MainWindow : Wpf.Ui.Controls.FluentWindow
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
            public string FontFamily { get; set; } = "Microsoft JhengHei";
            // Relative coordinates (0.0 to 1.0)
            public double RelX { get; set; }
            public double RelY { get; set; }
            public double OriginalRelX { get; set; }
            public double OriginalRelY { get; set; }
            public double RelWidth { get; set; }
            public double RelHeight { get; set; }
            
            public bool IsRemoved { get; set; }
            public bool IsEdited { get; set; } = false;
            
            // Formatting properties
            public double FontSize { get; set; } = 14;
            public bool IsBold { get; set; } = true;
            public bool IsItalic { get; set; } = false;
            public System.Windows.Media.Color TextColor { get; set; } = System.Windows.Media.Colors.Black;
            public System.Windows.Media.Color BackgroundColor { get; set; } = System.Windows.Media.Colors.Transparent;
            
            // Visual elements
            public System.Windows.Controls.Border? BorderElement { get; set; }
            public System.Windows.FrameworkElement? TextVisual { get; set; }
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
        private bool _isSaving = false;
        
        // Regional Re-OCR
        private bool _isSelectingRegion = false;
        private System.Windows.Point? _selectionStartPoint;
        private System.Windows.Shapes.Rectangle? _selectionRectUI;
        
        private List<System.Windows.Shapes.Line> _guideLines = new List<System.Windows.Shapes.Line>();

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

        private System.Windows.Threading.DispatcherTimer? _autoSaveTimer;

        public MainWindow()
        {
            LocalizationManager.ApplyLanguage("English");
            InitializeComponent();
            
            // Initialize WPF-UI Theme
            Wpf.Ui.Appearance.ApplicationThemeManager.Apply(this);
            
            InitializeEngine();
            SetupCanvasMouseEvents();
            PopulateFontFamilies();
            StartAutoSaveTimer();
        }

        private void StartAutoSaveTimer()
        {
            _autoSaveTimer = new System.Windows.Threading.DispatcherTimer();
            _autoSaveTimer.Interval = TimeSpan.FromSeconds(60);
            _autoSaveTimer.Tick += (s, e) => SaveDraftToHistory();
            _autoSaveTimer.Start();
        }

        private void SaveDraftToHistory()
        {
            if (_regions.Count == 0 || _ocrEngine == null || !_ocrEngine.IsReady)
                return;

            try
            {
                var options = new JsonSerializerOptions { WriteIndented = false };
                string jsonData = JsonSerializer.Serialize(_regions, options);
                string title = string.IsNullOrEmpty(_currentImagePath) ? "Untitled Draft" : Path.GetFileName(_currentImagePath);
                OCREngineInterop.SaveDraftToHistory("windows-draft-id", jsonData, title, _currentImagePath ?? "");
                System.Diagnostics.Debug.WriteLine("[MainWindow] Auto-saved draft to history.");
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[MainWindow] Auto-save failed: {ex.Message}");
            }
        }

        private void PopulateFontFamilies()
        {
            var fontNames = new List<string>();
            try
            {
                using (var installedFonts = new System.Drawing.Text.InstalledFontCollection())
                {
                    foreach (var family in installedFonts.Families)
                    {
                        fontNames.Add(family.Name);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to load installed fonts: {ex.Message}");
                foreach (var f in System.Windows.Media.Fonts.SystemFontFamilies)
                {
                    fontNames.Add(f.Source);
                }
            }

            fontNames = fontNames.Distinct().OrderBy(name => name).ToList();
            FontFamilyComboBox.ItemsSource = fontNames;
            PrimaryFontComboBox.ItemsSource = fontNames;
            SecondaryFontComboBox.ItemsSource = fontNames;
            
            var defaultFont = fontNames.FirstOrDefault(f => f.Contains("Microsoft JhengHei"));
            if (defaultFont != null)
            {
                FontFamilyComboBox.SelectedItem = defaultFont;
                PrimaryFontComboBox.SelectedItem = defaultFont;
            }
            else if (fontNames.Count > 0)
            {
                FontFamilyComboBox.SelectedIndex = 0;
                PrimaryFontComboBox.SelectedIndex = 0;
            }
            
            var defaultSecondary = fontNames.FirstOrDefault(f => f.Contains("Century Gothic"));
            if (defaultSecondary == null)
            {
                defaultSecondary = fontNames.FirstOrDefault(f => f.Contains("Segoe UI"));
            }
            if (defaultSecondary != null)
                SecondaryFontComboBox.SelectedItem = defaultSecondary;
            else if (fontNames.Count > 0)
                SecondaryFontComboBox.SelectedIndex = 0;
        }

        private void FontFamilyComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_isUpdatingUiFromSelection || _selectedRegion == null) return;
            
            var selectedFontName = FontFamilyComboBox.SelectedItem as string;
            if (selectedFontName != null)
            {
                SaveHistoryState();
                _selectedRegion.FontFamily = selectedFontName;
                _selectedRegion.IsEdited = true;
                RenderRegions();
            }
        }

        private void InitializeEngine(string language = "ch_tra,eng")
        {
            try
            {
                if (_ocrEngine != null)
                {
                    _ocrEngine.Dispose();
                    _ocrEngine = null;
                }

                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string modelsPath = Path.Combine(baseDir, "models");

                if (Directory.Exists(modelsPath))
                {
                    _ocrEngine = new OCREngineInterop(modelsPath, language);
                    StatusLabel.Text = $"OCR C++ Core Engine initialized (Lang: {language}).";
                    
                    // Try to load LLM model
                    string llmPath = Path.Combine(modelsPath, "llm_lightweight.gguf");
                    if (File.Exists(llmPath))
                    {
                        if (_ocrEngine.LoadLLMModel(llmPath))
                        {
                            StatusLabel.Text += " Local LLM Loaded.";
                        }
                    }
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

        private void LanguageComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (LanguageComboBox.SelectedItem is ComboBoxItem selectedItem && selectedItem.Tag is string langTag)
            {
                // langTag will be something like "zh-Hant" or "auto"
                // Map it to PaddleOCR formats if needed
                string mappedLanguage = "ch_tra,eng";
                if (langTag == "zh-Hans") mappedLanguage = "ch_sim,eng";
                else if (langTag == "en") mappedLanguage = "eng";
                else if (langTag == "ja") mappedLanguage = "japan";
                else if (langTag == "ko") mappedLanguage = "korean";

                InitializeEngine(mappedLanguage);
            }
        }

        private void SetupCanvasMouseEvents()
        {
            OverlayCanvas.MouseDown += Canvas_MouseDown;
            OverlayCanvas.MouseMove += Canvas_MouseMove;
            OverlayCanvas.MouseUp += Canvas_MouseUp;
        }

        #region Zoom Event Handlers

        private void ZoomIn_Click(object sender, RoutedEventArgs e)
        {
            if (ZoomSlider != null)
            {
                ZoomSlider.Value = Math.Min(ZoomSlider.Maximum, ZoomSlider.Value + 0.2);
            }
        }

        private void ZoomOut_Click(object sender, RoutedEventArgs e)
        {
            if (ZoomSlider != null)
            {
                ZoomSlider.Value = Math.Max(ZoomSlider.Minimum, ZoomSlider.Value - 0.2);
            }
        }

        private void ZoomReset_Click(object sender, RoutedEventArgs e)
        {
            if (ZoomSlider != null)
            {
                ZoomSlider.Value = 1.0;
            }
        }

        private void ZoomSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (CanvasScale != null)
            {
                CanvasScale.ScaleX = e.NewValue;
                CanvasScale.ScaleY = e.NewValue;
                if (DpiIndicator != null)
                {
                    DpiIndicator.Text = $"{(int)(e.NewValue * 100)}%";
                }
            }
        }

        private void ToggleLeftPanel_Click(object sender, RoutedEventArgs e)
        {
            if (LeftSidebar != null)
            {
                LeftSidebar.Visibility = MenuToggleLeft.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
            }
        }

        private void ToggleRightPanel_Click(object sender, RoutedEventArgs e)
        {
            if (RightSidebar != null)
            {
                RightSidebar.Visibility = MenuToggleRight.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
            }
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
                if (_isSelectingRegion)
                {
                    _selectionStartPoint = e.GetPosition(OverlayCanvas);
                    OverlayCanvas.CaptureMouse();
                    
                    _selectionRectUI = new System.Windows.Shapes.Rectangle
                    {
                        Stroke = System.Windows.Media.Brushes.Orange,
                        StrokeThickness = 2,
                        StrokeDashArray = new DoubleCollection() { 4, 4 },
                        Fill = new SolidColorBrush(System.Windows.Media.Color.FromArgb(50, 255, 165, 0))
                    };
                    Canvas.SetLeft(_selectionRectUI, _selectionStartPoint.Value.X);
                    Canvas.SetTop(_selectionRectUI, _selectionStartPoint.Value.Y);
                    OverlayCanvas.Children.Add(_selectionRectUI);
                    e.Handled = true;
                    return;
                }

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
            if (_isSelectingRegion && _selectionStartPoint.HasValue && _selectionRectUI != null)
            {
                var curPoint = e.GetPosition(OverlayCanvas);
                double x = Math.Min(_selectionStartPoint.Value.X, curPoint.X);
                double y = Math.Min(_selectionStartPoint.Value.Y, curPoint.Y);
                double w = Math.Abs(_selectionStartPoint.Value.X - curPoint.X);
                double h = Math.Abs(_selectionStartPoint.Value.Y - curPoint.Y);

                Canvas.SetLeft(_selectionRectUI, x);
                Canvas.SetTop(_selectionRectUI, y);
                _selectionRectUI.Width = w;
                _selectionRectUI.Height = h;
            }
            else if (_isDrawing && _dragRect != null)
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

        private async void Canvas_MouseUp(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            if (_isSelectingRegion && _selectionRectUI != null)
            {
                OverlayCanvas.ReleaseMouseCapture();

                double x = Canvas.GetLeft(_selectionRectUI);
                double y = Canvas.GetTop(_selectionRectUI);
                double w = _selectionRectUI.Width;
                double h = _selectionRectUI.Height;

                OverlayCanvas.Children.Remove(_selectionRectUI);
                _selectionRectUI = null;
                _selectionStartPoint = null;

                if (w > 15 && h > 10)
                {
                    await PerformRegionalOCRAsync(new System.Windows.Rect(x, y, w, h));
                }
                
                // Toggle off after use?
                // RegionOcrToggleButton.IsChecked = false; // Option to single-use
            }
            else if (_isDrawing && _dragRect != null)
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
                        FontSize = Math.Max(12, h * 1.3),
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

        private void CloseImage_Click(object sender, RoutedEventArgs e)
        {
            _currentImagePath = null;
            _regions.Clear();
            _undoStack.Clear();
            _redoStack.Clear();
            SourceImage.Source = null;
            if (_originalBitmapStream != null)
            {
                _originalBitmapStream.Dispose();
                _originalBitmapStream = null;
            }
            if (_originalBitmap != null)
            {
                _originalBitmap.Dispose();
                _originalBitmap = null;
            }
            LayerListBox.ItemsSource = null;
            OverlayCanvas.Children.Clear();
            StatusLabel.Text = "No Image Loaded";
            DpiIndicator.Text = "Image DPI: --";
            MenuUndo.IsEnabled = false;
            MenuRedo.IsEnabled = false;
            OcrTextBox.Text = "";
        }

        private async void OpenImage_Click(object sender, RoutedEventArgs e)
        {
            var openFileDialog = new Microsoft.Win32.OpenFileDialog
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
                    if (CanvasScale != null)
                    {
                        CanvasScale.ScaleX = 1.0;
                        CanvasScale.ScaleY = 1.0;
                        if (DpiIndicator != null) DpiIndicator.Text = $"Zoom: 100%";
                    }
                    
                    // Clear previous overlays and history
                    _regions.Clear();
                    _selectedRegion = null;
                    OcrTextBox.Text = string.Empty;
                    OverlayCanvas.Children.Clear();
                    LayerListBox.ItemsSource = null;
                    _undoStack.Clear();
                    _redoStack.Clear();
                    MenuUndo.IsEnabled = false;
                    MenuRedo.IsEnabled = false;
                    
                    await RunOCRAsync();
                }
                catch (Exception ex)
                {
                    System.Windows.MessageBox.Show($"Failed to load image: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
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

                var scaled = new Bitmap(targetWidth, targetHeight);
                using (var g = Graphics.FromImage(scaled))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(original, new System.Drawing.Rectangle(0, 0, targetWidth, targetHeight),
                        0, 0, original.Width, original.Height, GraphicsUnit.Pixel);
                }
                
                // Use the C++ Interop logic for consistency with Apple Vision contrast
                using (var processed = OCREngineInterop.PreprocessImage(scaled))
                {
                    string tempPath = Path.Combine(Path.GetTempPath(), "ocr_preprocessed.png");
                    processed.Save(tempPath, ImageFormat.Png);
                    return tempPath;
                }
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

                                // Estimate initial font size based on bounding box height relative to image source DIPs
                                double imgSourceHeight = SourceImage.Source?.Height ?? origH;
                                double relH = boxH / origH;
                                double estFontSize = Math.Max(12, imgSourceHeight * relH);

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
                            StatusLabel.Text = $"OCR Complete. Found {_regions.Count} text lines. Applying default font...";
                            
                            // Auto-apply default font to all regions after OCR
                            ApplyDefaultFontToAllRegions();
                            
                            StatusLabel.Text = $"OCR Complete. {_regions.Count} text lines rendered with default font.";
                        }
                    }
                    else
                    {
                        StatusLabel.Text = "System OCR Engine not available.";
                        System.Windows.MessageBox.Show("Could not initialize native OCR. Falling back to Sandbox Mode.", "OCR Notice", MessageBoxButton.OK, MessageBoxImage.Information);
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
                System.Windows.MessageBox.Show($"OCR failed: {ex.Message}\nFalling back to Sandbox Mode.", "OCR Notice", MessageBoxButton.OK, MessageBoxImage.Warning);
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
                if (_imgHeight > 0)
                {
                    r.FontSize = Math.Max(12, (SourceImage.Source?.Height ?? _imgHeight) * r.RelHeight * 1.0);
                }
                r.BackgroundColor = GetAverageColorOfRegion(r);
            }

            LayerListBox.ItemsSource = null;
            LayerListBox.ItemsSource = _regions;
            
            // Auto-apply default font in sandbox mode too
            ApplyDefaultFontToAllRegions();
        }

        private void ApplyDefaultFontToAll_Click(object sender, RoutedEventArgs e)
        {
            if (_regions.Count == 0)
            {
                System.Windows.MessageBox.Show("No text regions to apply font to. Please open an image and run OCR first.", "Info", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            SaveHistoryState();
            ApplyDefaultFontToAllRegions();
            StatusLabel.Text = $"Applied default font to all {_regions.Count} text regions.";
        }

        private void ApplyDefaultFontToAllRegions()
        {
            string primaryFont = "Microsoft JhengHei";
            if (PrimaryFontComboBox.SelectedItem is string selectedPrimary && !string.IsNullOrEmpty(selectedPrimary))
            {
                primaryFont = selectedPrimary;
            }
            
            string secondaryFont = "Century Gothic";
            if (SecondaryFontComboBox.SelectedItem is string selectedSecondary && !string.IsNullOrEmpty(selectedSecondary))
            {
                secondaryFont = selectedSecondary;
            }

            // Fallback font string (e.g. "Arial, Microsoft JhengHei")
            // The Latin font should be first so it handles English text, and CJK font second to handle Chinese characters
            string compositeFont = $"{secondaryFont}, {primaryFont}";

            bool forceComputerFont = MenuForceComputerFont.IsChecked;

            foreach (var region in _regions)
            {
                region.FontFamily = compositeFont;
                if (forceComputerFont)
                {
                    region.IsEdited = true;
                }
            }

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

        private void ClearGuideLines()
        {
            foreach (var line in _guideLines)
                OverlayCanvas.Children.Remove(line);
            _guideLines.Clear();
        }

        private void DrawVerticalGuide(double relX)
        {
            var line = new System.Windows.Shapes.Line
            {
                X1 = relX * _imgWidth,
                Y1 = 0,
                X2 = relX * _imgWidth,
                Y2 = _imgHeight,
                Stroke = System.Windows.Media.Brushes.Orange,
                StrokeThickness = 1,
                StrokeDashArray = new System.Windows.Media.DoubleCollection { 4, 4 }
            };
            OverlayCanvas.Children.Add(line);
            _guideLines.Add(line);
        }

        private void DrawHorizontalGuide(double relY)
        {
            var line = new System.Windows.Shapes.Line
            {
                X1 = 0,
                Y1 = relY * _imgHeight,
                X2 = _imgWidth,
                Y2 = relY * _imgHeight,
                Stroke = System.Windows.Media.Brushes.Orange,
                StrokeThickness = 1,
                StrokeDashArray = new System.Windows.Media.DoubleCollection { 4, 4 }
            };
            OverlayCanvas.Children.Add(line);
            _guideLines.Add(line);
        }

        private System.Windows.Media.Color GetAverageColorOfRegion(OCRRegion region)
        {
            lock (_bitmapLock)
            {
                if (_originalBitmap != null)
                {
                    try
                    {
                        int imgW = _originalBitmap.Width;
                        int imgH = _originalBitmap.Height;

                        int boxX = (int)(region.RelX * imgW);
                        int boxY = (int)(region.RelY * imgH);
                        int boxW = (int)(region.RelWidth * imgW);
                        int boxH = (int)(region.RelHeight * imgH);

                        // Expand slightly to get true background outside the text
                        int padding = 6;
                        int originalX = (int)Math.Round(region.OriginalRelX * imgW) - padding;
                        int originalY = (int)Math.Round(region.OriginalRelY * imgH) - padding;
                        int originalW = Math.Max(1, (int)Math.Round(region.RelWidth * imgW)) + padding * 2;
                        int originalH = Math.Max(1, (int)Math.Round(region.RelHeight * imgH)) + padding * 2;

                        int sumR = 0, sumG = 0, sumB = 0, count = 0;

                        // Only sample the 2-pixel outer perimeter to avoid any anti-aliased text pixels
                        for (int y = originalY; y < originalY + originalH; y++)
                        {
                            for (int x = originalX; x < originalX + originalW; x++)
                            {
                                if (x <= originalX + 1 || x >= originalX + originalW - 2 ||
                                    y <= originalY + 1 || y >= originalY + originalH - 2)
                                {
                                    int px = Math.Max(0, Math.Min(x, imgW - 1));
                                    int py = Math.Max(0, Math.Min(y, imgH - 1));
                                    var pixel = _originalBitmap.GetPixel(px, py);

                                    sumR += pixel.R;
                                    sumG += pixel.G;
                                    sumB += pixel.B;
                                    count++;
                                }
                            }
                        }

                        if (count > 0)
                        {
                            return System.Windows.Media.Color.FromRgb(
                                (byte)(sumR / count), (byte)(sumG / count), (byte)(sumB / count));
                        }
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"Local sampling failed: {ex.Message}");
                    }
                }
            }

            // Fallback: use quadrant-level background color
            return GetQuadrantBackgroundColor(region.RelX, region.RelY);
        }

        private bool HasMoved(OCRRegion region)
        {
            return Math.Abs(region.RelX - region.OriginalRelX) > 0.0001 ||
                   Math.Abs(region.RelY - region.OriginalRelY) > 0.0001;
        }

        private bool NeedsOriginalTextCover(OCRRegion region)
        {
            return region.IsRemoved || region.IsEdited || HasMoved(region);
        }

        private bool ShouldRenderReplacementText(OCRRegion region)
        {
            return region.IsEdited || HasMoved(region);
        }

        private System.Windows.Media.Color GetAverageCornerColor(int cx, int cy, int imgW, int imgH)
        {
            int sumR = 0, sumG = 0, sumB = 0, count = 0;
            for (int dy = -2; dy <= 2; dy++)
            {
                for (int dx = -2; dx <= 2; dx++)
                {
                    int px = Math.Max(0, Math.Min(cx + dx, imgW - 1));
                    int py = Math.Max(0, Math.Min(cy + dy, imgH - 1));
                    var p = _originalBitmap.GetPixel(px, py);
                    sumR += p.R; sumG += p.G; sumB += p.B;
                    count++;
                }
            }
            if (count == 0) return System.Windows.Media.Colors.Transparent;
            return System.Windows.Media.Color.FromRgb((byte)(sumR/count), (byte)(sumG/count), (byte)(sumB/count));
        }

        private System.Windows.Media.Brush CreateInpaintedBackgroundSprite(OCRRegion region, int paddingPixels)
        {
            lock (_bitmapLock)
            {
                if (_originalBitmap != null)
                {
                    try
                    {
                        int imgW = _originalBitmap.Width;
                        int imgH = _originalBitmap.Height;

                        // Calculate padding relative to original bitmap size
                        int paddingX = (int)Math.Ceiling(paddingPixels * ((double)imgW / _imgWidth));
                        int paddingY = (int)Math.Ceiling(paddingPixels * ((double)imgH / _imgHeight));

                        int originalX = (int)Math.Round(region.OriginalRelX * imgW) - paddingX;
                        int originalY = (int)Math.Round(region.OriginalRelY * imgH) - paddingY;
                        int originalW = Math.Max(1, (int)Math.Round(region.RelWidth * imgW)) + paddingX * 2;
                        int originalH = Math.Max(1, (int)Math.Round(region.RelHeight * imgH)) + paddingY * 2;
                        
                        // Ensure bounds
                        originalX = Math.Max(0, Math.Min(originalX, imgW - 1));
                        originalY = Math.Max(0, Math.Min(originalY, imgH - 1));
                        originalW = Math.Min(originalW, imgW - originalX);
                        originalH = Math.Min(originalH, imgH - originalY);

                        var pixels = new byte[originalW * originalH * 4];

                        int feather = Math.Min(Math.Max(paddingX, paddingY), Math.Min(originalW, originalH) / 3);

                        var cTL = GetAverageCornerColor(originalX, originalY, imgW, imgH);
                        var cTR = GetAverageCornerColor(originalX + originalW - 1, originalY, imgW, imgH);
                        var cBL = GetAverageCornerColor(originalX, originalY + originalH - 1, imgW, imgH);
                        var cBR = GetAverageCornerColor(originalX + originalW - 1, originalY + originalH - 1, imgW, imgH);

                        for (int y = 0; y < originalH; y++)
                        {
                            for (int x = 0; x < originalW; x++)
                            {
                                int index = (y * originalW + x) * 4;
                                
                                double tx = originalW > 1 ? (double)x / (originalW - 1) : 0;
                                double ty = originalH > 1 ? (double)y / (originalH - 1) : 0;
                                
                                double rTop = cTL.R * (1 - tx) + cTR.R * tx;
                                double gTop = cTL.G * (1 - tx) + cTR.G * tx;
                                double bTop = cTL.B * (1 - tx) + cTR.B * tx;

                                double rBot = cBL.R * (1 - tx) + cBR.R * tx;
                                double gBot = cBL.G * (1 - tx) + cBR.G * tx;
                                double bBot = cBL.B * (1 - tx) + cBR.B * tx;

                                byte r = (byte)Math.Min(255, Math.Max(0, rTop * (1 - ty) + rBot * ty));
                                byte g = (byte)Math.Min(255, Math.Max(0, gTop * (1 - ty) + gBot * ty));
                                byte b = (byte)Math.Min(255, Math.Max(0, bTop * (1 - ty) + bBot * ty));

                                int distX = Math.Min(x, originalW - 1 - x);
                                int distY = Math.Min(y, originalH - 1 - y);
                                int distToEdge = Math.Min(distX, distY);
                                
                                byte alpha = 255;
                                if (distToEdge < feather)
                                {
                                    alpha = (byte)(255 * ((double)distToEdge / feather));
                                }

                                pixels[index] = b;
                                pixels[index + 1] = g;
                                pixels[index + 2] = r;
                                pixels[index + 3] = alpha;
                            }
                        }

                        var bitmap = new WriteableBitmap(
                            originalW, originalH, 96, 96, PixelFormats.Bgra32, null);
                        bitmap.WritePixels(new Int32Rect(0, 0, originalW, originalH), pixels, originalW * 4, 0);

                        var brush = new ImageBrush(bitmap)
                        {
                            Stretch = Stretch.Fill,
                            TileMode = TileMode.None
                        };
                        brush.Freeze();
                        return brush;
                    }
                    catch {}
                }
            }

            return System.Windows.Media.Brushes.Transparent;
        }

        private System.Windows.Media.Brush CreateTransparentTextSprite(OCRRegion region)
        {
            lock (_bitmapLock)
            {
                if (_originalBitmap != null)
                {
                    try
                    {
                        int imgW = _originalBitmap.Width;
                        int imgH = _originalBitmap.Height;

                        int originalX = (int)Math.Round(region.OriginalRelX * imgW);
                        int originalY = (int)Math.Round(region.OriginalRelY * imgH);
                        int originalW = Math.Max(1, (int)Math.Round(region.RelWidth * imgW));
                        int originalH = Math.Max(1, (int)Math.Round(region.RelHeight * imgH));
                        
                        // Ensure bounds
                        originalX = Math.Max(0, Math.Min(originalX, imgW - 1));
                        originalY = Math.Max(0, Math.Min(originalY, imgH - 1));
                        originalW = Math.Min(originalW, imgW - originalX);
                        originalH = Math.Min(originalH, imgH - originalY);

                        var pixels = new byte[originalW * originalH * 4];
                        
                        var bg = region.BackgroundColor;

                        for (int y = 0; y < originalH; y++)
                        {
                            for (int x = 0; x < originalW; x++)
                            {
                                var pixel = _originalBitmap.GetPixel(originalX + x, originalY + y);
                                int index = (y * originalW + x) * 4;
                                
                                int dr = pixel.R - bg.R;
                                int dg = pixel.G - bg.G;
                                int db = pixel.B - bg.B;
                                
                                // If the color is close to the background color, make it transparent
                                // We use a smooth transition (alpha blending) for anti-aliased edges
                                double dist = Math.Sqrt(dr * dr + dg * dg + db * db);
                                double maxDist = 80.0;
                                
                                byte alpha = 255;
                                if (dist < maxDist)
                                {
                                    // Smooth alpha interpolation
                                    alpha = (byte)(255 * (dist / maxDist));
                                }

                                pixels[index] = pixel.B;
                                pixels[index + 1] = pixel.G;
                                pixels[index + 2] = pixel.R;
                                pixels[index + 3] = alpha;
                            }
                        }

                        var bitmap = new WriteableBitmap(
                            originalW,
                            originalH,
                            96,
                            96,
                            PixelFormats.Bgra32,
                            null);
                        bitmap.WritePixels(new Int32Rect(0, 0, originalW, originalH), pixels, originalW * 4, 0);

                        var brush = new ImageBrush(bitmap)
                        {
                            Stretch = Stretch.Fill,
                            TileMode = TileMode.None
                        };
                        brush.Freeze();
                        return brush;
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"Sprite generation failed: {ex.Message}");
                    }
                }
            }

            return System.Windows.Media.Brushes.Transparent;
        }

        private byte CalculateFeatherAlpha(int x, int y, int width, int height, int feather)
        {
            if (feather <= 0)
                return 255;

            int distanceToEdge = Math.Min(Math.Min(x, width - 1 - x), Math.Min(y, height - 1 - y));
            if (distanceToEdge >= feather)
                return 255;

            double t = Math.Max(0.0, Math.Min(1.0, (double)distanceToEdge / feather));
            t = t * t * (3.0 - 2.0 * t);
            return (byte)Math.Round(255 * t);
        }

        private System.Windows.Media.Color SampleBackgroundPixel(int x, int y, int stepX, int stepY, System.Windows.Media.Color expectedBg)
        {
            if (_originalBitmap == null)
                return expectedBg;

            int imgW = _originalBitmap.Width;
            int imgH = _originalBitmap.Height;

            for (int distance = 0; distance <= 28; distance += 2)
            {
                int px = Math.Max(0, Math.Min(x + stepX * distance, imgW - 1));
                int py = Math.Max(0, Math.Min(y + stepY * distance, imgH - 1));
                var pixel = _originalBitmap.GetPixel(px, py);

                // If pixel color is close to the calculated background, accept it as background
                int dr = pixel.R - expectedBg.R;
                int dg = pixel.G - expectedBg.G;
                int db = pixel.B - expectedBg.B;
                if (Math.Sqrt(dr * dr + dg * dg + db * db) < 150) // Relaxed threshold to allow for gradients/textures
                {
                    return System.Windows.Media.Color.FromRgb(pixel.R, pixel.G, pixel.B);
                }
            }

            return expectedBg;
        }

        private System.Windows.Media.Color BlendColors(System.Windows.Media.Color a, System.Windows.Media.Color b, double amount)
        {
            amount = Math.Max(0.0, Math.Min(1.0, amount));
            return System.Windows.Media.Color.FromRgb(
                (byte)Math.Round(a.R + (b.R - a.R) * amount),
                (byte)Math.Round(a.G + (b.G - a.G) * amount),
                (byte)Math.Round(a.B + (b.B - a.B) * amount));
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

        private void OverlayCanvas_MouseLeftButtonDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            if (_imgWidth <= 0 || _imgHeight <= 0) return;

            // Only allow insert if the Insert Text button is active
            if (MenuInsertText.IsChecked != true) return;

            // Make sure we didn't click on an existing region
            if (e.OriginalSource is System.Windows.Controls.Border border && border.Tag is OCRRegion) return;
            if (e.OriginalSource is System.Windows.Controls.TextBlock) return;

            SaveHistoryState();

            var pos = e.GetPosition(OverlayCanvas);
            double defaultRelWidth = 100.0 / _imgWidth;
            double defaultRelHeight = 30.0 / _imgHeight;

            var newRegion = new OCRRegion
            {
                OriginalText = "",
                CurrentText = "New Text",
                RelX = pos.X / _imgWidth,
                RelY = pos.Y / _imgHeight,
                OriginalRelX = pos.X / _imgWidth,
                OriginalRelY = pos.Y / _imgHeight,
                RelWidth = defaultRelWidth,
                RelHeight = defaultRelHeight,
                FontSize = Math.Max(12, 30.0 * 1.0),
                BackgroundColor = System.Windows.Media.Colors.Transparent,
                TextColor = System.Windows.Media.Colors.Black,
                IsEdited = true
            };

            _regions.Add(newRegion);
            
            LayerListBox.ItemsSource = null;
            LayerListBox.ItemsSource = _regions;
            
            SelectRegion(newRegion);
            
            // Turn off insert mode after adding one to prevent accidental clicks
            MenuInsertText.IsChecked = false;

            // Focus the TextBox to start typing immediately
            OcrTextBox.Focus();
            OcrTextBox.SelectAll();
        }

        private void PrepareRegionForTransform(OCRRegion region, System.Windows.Controls.Border border)
        {
            if (!region.IsEdited && !HasMoved(region))
            {
                // Assign transparent sprite to border so user can see it dragging/resizing
                border.Background = CreateTransparentTextSprite(region);

                // Add an inpainted cover where it used to be so it doesn't leave a ghost behind
                int padding = 6;
                double sLeft = Math.Max(0.0, region.OriginalRelX * _imgWidth - padding);
                double sTop = Math.Max(0.0, region.OriginalRelY * _imgHeight - padding);
                double baseWidth = region.RelWidth * _imgWidth;
                double baseHeight = region.RelHeight * _imgHeight;
                double sWidth = Math.Min(_imgWidth - sLeft, baseWidth + padding * 2);
                double sHeight = Math.Min(_imgHeight - sTop, baseHeight + padding * 2);

                var staticCover = new System.Windows.Controls.Border
                {
                    Width = sWidth,
                    Height = sHeight,
                    Background = CreateInpaintedBackgroundSprite(region, padding),
                    BorderThickness = new Thickness(0)
                };
                Canvas.SetLeft(staticCover, sLeft);
                Canvas.SetTop(staticCover, sTop);

                // Insert at bottom so it doesn't cover other active borders
                OverlayCanvas.Children.Insert(0, staticCover);
            }
        }

        private void RenderRegions()
        {
            OverlayCanvas.Children.Clear();
            
            if (_imgWidth <= 0 || _imgHeight <= 0) return;
            
            // 1. First, draw static background covers that precisely paint over the original text strokes
            // This leaves the surrounding background texture completely untouched to avoid 'holes' or 'pits'.
            foreach (var region in _regions)
            {
                // We cover the original text strokes if it's edited, moved, or marked as removed (to erase it).
                if (region.IsRemoved || ShouldRenderReplacementText(region))
                {
                    // For the inpaint sprite, we use a padding to ensure we catch all text strokes
                    int padding = 6;
                    double baseWidth = region.RelWidth * _imgWidth;
                    double baseHeight = region.RelHeight * _imgHeight;
                    
                    // We calculate the source bounding box relative to screen space
                    double sLeft = Math.Max(0.0, region.OriginalRelX * _imgWidth - padding);
                    double sTop = Math.Max(0.0, region.OriginalRelY * _imgHeight - padding);
                    double sWidth = Math.Min(_imgWidth - sLeft, baseWidth + padding * 2);
                    double sHeight = Math.Min(_imgHeight - sTop, baseHeight + padding * 2);

                    var staticCover = new System.Windows.Controls.Border
                    {
                        Width = sWidth,
                        Height = sHeight,
                        Background = CreateInpaintedBackgroundSprite(region, padding),
                        BorderThickness = new Thickness(0)
                    };
                    Canvas.SetLeft(staticCover, sLeft);
                    Canvas.SetTop(staticCover, sTop);
                    OverlayCanvas.Children.Add(staticCover);
                }
            }

            // 2. Next, draw interactive, draggable text layers
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
                    Background = System.Windows.Media.Brushes.Transparent,
                    BorderThickness = new Thickness(1),
                    Cursor = System.Windows.Input.Cursors.Hand,
                    Tag = region
                };
                
                if (_isSaving)
                {
                    border.BorderThickness = new Thickness(0);
                    border.Background = System.Windows.Media.Brushes.Transparent;
                }
                else if (region == _selectedRegion)
                {
                    border.BorderBrush = System.Windows.Media.Brushes.DodgerBlue;
                    border.BorderThickness = new Thickness(1.5);
                }
                else
                {
                    border.BorderBrush = System.Windows.Media.Brushes.Orange;
                    border.BorderThickness = new Thickness(1);
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
                        border.Background = System.Windows.Media.Brushes.Transparent;
                    }
                };
                
                border.MouseDown += (s, e) =>
                {
                    if (e.LeftButton == System.Windows.Input.MouseButtonState.Pressed)
                    {
                        SaveHistoryState();
                        
                        _isDraggingRegion = true;
                        _draggingRegion = region;
                        _dragStartMousePos = e.GetPosition(OverlayCanvas); // Relative to Canvas
                        _dragStartRelX = region.RelX;
                        _dragStartRelY = region.RelY;
                        
                        PrepareRegionForTransform(region, border);
                        
                        border.CaptureMouse();
                        SelectRegion(region);
                        e.Handled = true;
                    }
                };

                border.MouseMove += (s, e) =>
                {
                    if (_isDraggingRegion && _draggingRegion == region)
                    {
                        var curMousePos = e.GetPosition(OverlayCanvas); // Relative to Canvas
                        double deltaX = curMousePos.X - _dragStartMousePos.X;
                        double deltaY = curMousePos.Y - _dragStartMousePos.Y;
                        
                        double rawRelX = _dragStartRelX + (deltaX / _imgWidth);
                        double rawRelY = _dragStartRelY + (deltaY / _imgHeight);
                        
                        double snappedRelX = rawRelX;
                        double snappedRelY = rawRelY;
                        
                        double myLeft = rawRelX;
                        double myHCenter = rawRelX + region.RelWidth / 2;
                        double myRight = rawRelX + region.RelWidth;
                        
                        double myTop = rawRelY;
                        double myVCenter = rawRelY + region.RelHeight / 2;
                        double myBottom = rawRelY + region.RelHeight;
                        
                        double snapThresholdX = 4.0 / _imgWidth;
                        double snapThresholdY = 4.0 / _imgHeight;
                        
                        bool didSnapX = false;
                        bool didSnapY = false;
                        
                        ClearGuideLines();
                        
                        foreach (var other in _regions) {
                            if (other == region || other.IsRemoved) continue;
                            
                            double oLeft = other.RelX;
                            double oHCenter = other.RelX + other.RelWidth / 2;
                            double oRight = other.RelX + other.RelWidth;
                            
                            double oTop = other.RelY;
                            double oVCenter = other.RelY + other.RelHeight / 2;
                            double oBottom = other.RelY + other.RelHeight;
                            
                            if (!didSnapX) {
                                if (Math.Abs(myLeft - oLeft) < snapThresholdX) { snappedRelX = oLeft; didSnapX = true; DrawVerticalGuide(oLeft); }
                                else if (Math.Abs(myRight - oRight) < snapThresholdX) { snappedRelX = oRight - region.RelWidth; didSnapX = true; DrawVerticalGuide(oRight); }
                                else if (Math.Abs(myHCenter - oHCenter) < snapThresholdX) { snappedRelX = oHCenter - region.RelWidth / 2; didSnapX = true; DrawVerticalGuide(oHCenter); }
                            }
                            
                            if (!didSnapY) {
                                if (Math.Abs(myTop - oTop) < snapThresholdY) { snappedRelY = oTop; didSnapY = true; DrawHorizontalGuide(oTop); }
                                else if (Math.Abs(myBottom - oBottom) < snapThresholdY) { snappedRelY = oBottom - region.RelHeight; didSnapY = true; DrawHorizontalGuide(oBottom); }
                                else if (Math.Abs(myVCenter - oVCenter) < snapThresholdY) { snappedRelY = oVCenter - region.RelHeight / 2; didSnapY = true; DrawHorizontalGuide(oVCenter); }
                            }
                        }
                        
                        region.RelX = Math.Max(0.0, Math.Min(snappedRelX, 1.0 - region.RelWidth));
                        region.RelY = Math.Max(0.0, Math.Min(snappedRelY, 1.0 - region.RelHeight));
                        
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
                        ClearGuideLines();
                        
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
                
                var grid = new System.Windows.Controls.Grid();

                if (region.IsEdited)
                {
                    // Edited text: render as TextBlock with user-specified styles
                    var textBlock = new System.Windows.Controls.TextBlock
                    {
                        Text = region.CurrentText,
                        Foreground = new System.Windows.Media.SolidColorBrush(region.TextColor),
                        FontFamily = new System.Windows.Media.FontFamily(region.FontFamily),
                        FontSize = region.FontSize * scale,
                        FontWeight = region.IsBold ? FontWeights.Bold : FontWeights.Normal,
                        FontStyle = region.IsItalic ? FontStyles.Italic : FontStyles.Normal,
                        VerticalAlignment = VerticalAlignment.Center,
                        HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                        TextAlignment = TextAlignment.Center,
                        TextWrapping = TextWrapping.Wrap
                    };

                    var viewbox = new System.Windows.Controls.Viewbox
                    {
                        Stretch = System.Windows.Media.Stretch.Uniform,
                        StretchDirection = System.Windows.Controls.StretchDirection.DownOnly,
                        Child = textBlock
                    };

                    grid.Children.Add(viewbox);
                    region.TextVisual = textBlock;
                }
                else if (HasMoved(region))
                {
                    // Moved but NOT edited: use original bitmap sprite to preserve exact appearance
                    border.Background = CreateTransparentTextSprite(region);
                    region.TextVisual = null;
                }
                else
                {
                    region.TextVisual = null;
                }
                
                if (!_isSaving && region == _selectedRegion)
                {
                    var resizeHandle = new System.Windows.Controls.Border
                    {
                        Width = 10,
                        Height = 10,
                        Background = System.Windows.Media.Brushes.DodgerBlue,
                        HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
                        VerticalAlignment = System.Windows.VerticalAlignment.Bottom,
                        Cursor = System.Windows.Input.Cursors.SizeNWSE,
                        Margin = new Thickness(0, 0, -5, -5)
                    };
                    
                    bool isResizing = false;
                    System.Windows.Point resizeStartPos = new System.Windows.Point();
                    double startWidth = 0;
                    double startHeight = 0;

                    resizeHandle.MouseLeftButtonDown += (rs, re) =>
                    {
                        isResizing = true;
                        resizeStartPos = re.GetPosition(OverlayCanvas);
                        startWidth = border.Width;
                        startHeight = border.Height;
                        
                        PrepareRegionForTransform(region, border);
                        
                        resizeHandle.CaptureMouse();
                        re.Handled = true;
                    };

                    resizeHandle.MouseMove += (rs, re) =>
                    {
                        if (isResizing)
                        {
                            var curPos = re.GetPosition(OverlayCanvas);
                            double newWidth = Math.Max(20, startWidth + (curPos.X - resizeStartPos.X));
                            double newHeight = Math.Max(20, startHeight + (curPos.Y - resizeStartPos.Y));
                            
                            border.Width = newWidth;
                            border.Height = newHeight;
                            
                            region.RelWidth = newWidth / _imgWidth;
                            region.RelHeight = newHeight / _imgHeight;
                            re.Handled = true;
                        }
                    };

                    resizeHandle.MouseLeftButtonUp += (rs, re) =>
                    {
                        if (isResizing)
                        {
                            isResizing = false;
                            resizeHandle.ReleaseMouseCapture();
                            RenderRegions();
                            re.Handled = true;
                        }
                    };
                    
                    grid.Children.Add(resizeHandle);
                }

                border.Child = grid;
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
            
            foreach (var item in FontFamilyComboBox.Items)
            {
                if (item is string fontName && fontName == region.FontFamily)
                {
                    FontFamilyComboBox.SelectedItem = item;
                    break;
                }
            }
            
            _isUpdatingUiFromSelection = false;
            
            StatusLabel.Text = "Selected text layer. Update styles or text content.";
            RenderRegions();

            if (MainScrollViewer != null && _imgWidth > 0 && _imgHeight > 0 && CanvasScale != null)
            {
                double centerX = (region.RelX + region.RelWidth / 2.0) * _imgWidth;
                double centerY = (region.RelY + region.RelHeight / 2.0) * _imgHeight;
                
                double scaledCenterX = centerX * CanvasScale.ScaleX;
                double scaledCenterY = centerY * CanvasScale.ScaleY;
                
                double offsetX = scaledCenterX - (MainScrollViewer.ViewportWidth / 2.0);
                double offsetY = scaledCenterY - (MainScrollViewer.ViewportHeight / 2.0);
                
                if (offsetX < 0) offsetX = 0;
                if (offsetY < 0) offsetY = 0;
                
                MainScrollViewer.ScrollToHorizontalOffset(offsetX);
                MainScrollViewer.ScrollToVerticalOffset(offsetY);
            }
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

        private void LanguageComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_currentImagePath != null && File.Exists(_currentImagePath))
            {
                // Re-run OCR automatically when language is changed
                _ = RunOCRAsync();
            }
        }

        private void UiLanguageComboBox_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (sender is System.Windows.Controls.ComboBox cb && cb.SelectedItem is System.Windows.Controls.ComboBoxItem item)
            {
                string lang = item.Tag?.ToString() ?? "English";
                LocalizationManager.ApplyLanguage(lang);
            }
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
            if (_selectedRegion == null || !(sender is System.Windows.Controls.Button button)) return;
            
            SaveHistoryState();
            
            if (button.Background is SolidColorBrush brush)
            {
                _selectedRegion.TextColor = brush.Color;
                _selectedRegion.IsEdited = true;
                RenderRegions();
            }
        }

        private void CustomColor_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion == null) return;
            
            using (var colorDialog = new System.Windows.Forms.ColorDialog())
            {
                colorDialog.Color = System.Drawing.Color.FromArgb(
                    _selectedRegion.TextColor.A, 
                    _selectedRegion.TextColor.R, 
                    _selectedRegion.TextColor.G, 
                    _selectedRegion.TextColor.B);
                    
                if (colorDialog.ShowDialog() == System.Windows.Forms.DialogResult.OK)
                {
                    SaveHistoryState();
                    _selectedRegion.TextColor = System.Windows.Media.Color.FromArgb(
                        colorDialog.Color.A, 
                        colorDialog.Color.R, 
                        colorDialog.Color.G, 
                        colorDialog.Color.B);
                    _selectedRegion.IsEdited = true;
                    RenderRegions();
                }
            }
        }

        private void RegionOcrToggle_Checked(object sender, RoutedEventArgs e)
        {
            _isSelectingRegion = true;
            OverlayCanvas.Cursor = System.Windows.Input.Cursors.Cross;
            StatusLabel.Text = "Draw a rectangle on the canvas to re-run OCR on that region.";
        }

        private void RegionOcrToggle_Unchecked(object sender, RoutedEventArgs e)
        {
            _isSelectingRegion = false;
            OverlayCanvas.Cursor = System.Windows.Input.Cursors.Arrow;
            StatusLabel.Text = "Regional OCR mode disabled.";
        }

        private async System.Threading.Tasks.Task PerformRegionalOCRAsync(System.Windows.Rect rect)
        {
            if (_ocrEngine == null || !_ocrEngine.IsReady || _originalBitmap == null) return;

            StatusLabel.Text = "Running Regional OCR...";
            ProgressBar.Visibility = Visibility.Visible;
            ProgressBar.IsIndeterminate = true;

            try
            {
                // Convert WPF Rect to physical pixels
                System.Drawing.Rectangle region = new System.Drawing.Rectangle(
                    (int)rect.X, (int)rect.Y, (int)rect.Width, (int)rect.Height);

                var result = await System.Threading.Tasks.Task.Run(() => 
                {
                    lock (_bitmapLock)
                    {
                        if (_originalBitmap == null) return null;
                        
                        var processedImage = OCREngineInterop.PreprocessImage(_originalBitmap);
                        var res = _ocrEngine.RecognizeRegion(processedImage ?? _originalBitmap, region);
                        processedImage?.Dispose();
                        return res;
                    }
                });

                if (result != null && result.Blocks.Count > 0)
                {
                    SaveHistoryState();
                    
                    foreach (var block in result.Blocks)
                    {
                        var newRegion = new OCRRegion
                        {
                            OriginalText = block.Text,
                            CurrentText = block.Text,
                            RelX = (rect.X + block.BoundingBox.X) / _imgWidth,
                            RelY = (rect.Y + block.BoundingBox.Y) / _imgHeight,
                            OriginalRelX = (rect.X + block.BoundingBox.X) / _imgWidth,
                            OriginalRelY = (rect.Y + block.BoundingBox.Y) / _imgHeight,
                            RelWidth = block.BoundingBox.Width / _imgWidth,
                            RelHeight = block.BoundingBox.Height / _imgHeight,
                            FontSize = Math.Max(12, block.BoundingBox.Height * 0.8),
                            IsEdited = false
                        };

                        _regions.Add(newRegion);
                    }

                    LayerListBox.ItemsSource = null;
                    LayerListBox.ItemsSource = _regions;
                    RenderRegions();
                    
                    StatusLabel.Text = $"Regional OCR complete. Found {result.Blocks.Count} blocks.";
                }
                else
                {
                    StatusLabel.Text = "No text found in region.";
                }
            }
            finally
            {
                ProgressBar.Visibility = Visibility.Hidden;
                ProgressBar.IsIndeterminate = false;
                RegionOcrToggleButton.IsChecked = false;
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
                System.Windows.MessageBox.Show("Please select a text layer first.", "Inpainting", MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }

        // -- LLM Action Handlers --------------------------------------------

        private async void FixTextWithLLM_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion == null || _ocrEngine == null || !_ocrEngine.IsReady)
            {
                StatusLabel.Text = "Please select a text layer and ensure LLM is ready.";
                return;
            }

            string originalText = _selectedRegion.CurrentText;
            if (string.IsNullOrWhiteSpace(originalText)) return;

            StatusLabel.Text = "Fixing text with LLM...";
            ProgressBar.Visibility = Visibility.Visible;
            ProgressBar.IsIndeterminate = true;

            try
            {
                string? fixedText = await System.Threading.Tasks.Task.Run(() =>
                {
                    return _ocrEngine.FixTextWithLLM(originalText);
                });

                if (!string.IsNullOrEmpty(fixedText))
                {
                    SaveHistoryState();
                    _selectedRegion.CurrentText = fixedText;
                    _selectedRegion.IsEdited = true;
                    _isUpdatingUiFromSelection = true;
                    OcrTextBox.Text = fixedText;
                    _isUpdatingUiFromSelection = false;
                    RenderRegions();
                    StatusLabel.Text = "Text fixed with LLM.";
                }
                else
                {
                    StatusLabel.Text = "LLM fix returned empty or failed.";
                }
            }
            catch (Exception ex)
            {
                StatusLabel.Text = $"LLM Error: {ex.Message}";
            }
            finally
            {
                ProgressBar.Visibility = Visibility.Collapsed;
            }
        }

        private async void ExtractEntitiesWithLLM_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion == null || _ocrEngine == null || !_ocrEngine.IsReady)
            {
                StatusLabel.Text = "Please select a text layer and ensure LLM is ready.";
                return;
            }

            string originalText = _selectedRegion.CurrentText;
            if (string.IsNullOrWhiteSpace(originalText)) return;

            StatusLabel.Text = "Extracting entities with LLM...";
            ProgressBar.Visibility = Visibility.Visible;
            ProgressBar.IsIndeterminate = true;

            try
            {
                string? entitiesText = await System.Threading.Tasks.Task.Run(() =>
                {
                    return _ocrEngine.ExtractEntitiesWithLLM(originalText);
                });

                if (!string.IsNullOrEmpty(entitiesText))
                {
                    SaveHistoryState();
                    string combined = $"【Entities】\n{entitiesText}\n\n【Original】\n{originalText}";
                    _selectedRegion.CurrentText = combined;
                    _selectedRegion.IsEdited = true;
                    _isUpdatingUiFromSelection = true;
                    OcrTextBox.Text = combined;
                    _isUpdatingUiFromSelection = false;
                    RenderRegions();
                    StatusLabel.Text = "Entities extracted.";
                }
                else
                {
                    StatusLabel.Text = "LLM extraction returned empty or failed.";
                }
            }
            catch (Exception ex)
            {
                StatusLabel.Text = $"LLM Error: {ex.Message}";
            }
            finally
            {
                ProgressBar.Visibility = Visibility.Collapsed;
            }
        }

        private async void TranslateWithLLM_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion == null || _ocrEngine == null || !_ocrEngine.IsReady)
            {
                StatusLabel.Text = "Please select a text layer and ensure LLM is ready.";
                return;
            }

            string originalText = _selectedRegion.CurrentText;
            if (string.IsNullOrWhiteSpace(originalText)) return;

            StatusLabel.Text = "Translating text with LLM...";
            ProgressBar.Visibility = Visibility.Visible;
            ProgressBar.IsIndeterminate = true;

            try
            {
                string? translatedText = await System.Threading.Tasks.Task.Run(() =>
                {
                    return _ocrEngine.TranslateWithLLM(originalText, "Traditional Chinese");
                });

                if (!string.IsNullOrEmpty(translatedText))
                {
                    SaveHistoryState();
                    _selectedRegion.CurrentText = translatedText;
                    _selectedRegion.IsEdited = true;
                    _isUpdatingUiFromSelection = true;
                    OcrTextBox.Text = translatedText;
                    _isUpdatingUiFromSelection = false;
                    RenderRegions();
                    StatusLabel.Text = "Text translated.";
                }
                else
                {
                    StatusLabel.Text = "LLM translation returned empty or failed.";
                }
            }
            catch (Exception ex)
            {
                StatusLabel.Text = $"LLM Error: {ex.Message}";
            }
            finally
            {
                ProgressBar.Visibility = Visibility.Collapsed;
            }
        }

        // -------------------------------------------------------------------

        private void Translate_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion == null)
            {
                System.Windows.MessageBox.Show("Please select a text layer first.", "Translation", MessageBoxButton.OK, MessageBoxImage.Information);
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
            
            MenuUndo.IsEnabled = true;
            MenuRedo.IsEnabled = false;
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
            
            MenuUndo.IsEnabled = _undoStack.Count > 0;
            MenuRedo.IsEnabled = true;
            
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
            
            MenuUndo.IsEnabled = true;
            MenuRedo.IsEnabled = _redoStack.Count > 0;
            
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
                System.Windows.MessageBox.Show("No image to save.", "Save", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var saveFileDialog = new Microsoft.Win32.SaveFileDialog
            {
                Filter = "PNG Image|*.png|JPEG Image|*.jpg",
                FileName = Path.GetFileNameWithoutExtension(_currentImagePath) + "_edited"
            };

            if (saveFileDialog.ShowDialog() == true)
            {
                try
                {
                    var bitmapSource = SourceImage.Source as BitmapSource;
                    if (bitmapSource == null) return;
                    
                    int pixelWidth = bitmapSource.PixelWidth;
                    int pixelHeight = bitmapSource.PixelHeight;
                    
                    double dpiX = bitmapSource.DpiX > 0 ? bitmapSource.DpiX : 96.0;
                    double dpiY = bitmapSource.DpiY > 0 ? bitmapSource.DpiY : 96.0;

                    var tempSelected = _selectedRegion;
                    double originalZoom = CanvasScale != null ? CanvasScale.ScaleX : 1.0;
                    
                    _isSaving = true;
                    _selectedRegion = null;
                    
                    if (CanvasScale != null)
                    {
                        CanvasScale.ScaleX = 1.0;
                        CanvasScale.ScaleY = 1.0;
                    }
                    
                    RenderRegions();
                    
                    CanvasGrid.Measure(new System.Windows.Size(_imgWidth, _imgHeight));
                    CanvasGrid.Arrange(new System.Windows.Rect(0, 0, _imgWidth, _imgHeight));
                    CanvasGrid.UpdateLayout();
                    
                    var rtb = new RenderTargetBitmap(pixelWidth, pixelHeight, dpiX, dpiY, PixelFormats.Pbgra32);
                    rtb.Render(CanvasGrid);
                    
                    _isSaving = false;
                    _selectedRegion = tempSelected;
                    
                    if (CanvasScale != null)
                    {
                        CanvasScale.ScaleX = originalZoom;
                        CanvasScale.ScaleY = originalZoom;
                    }
                    
                    RenderRegions();

                    var encoder = saveFileDialog.FilterIndex == 1 
                        ? (BitmapEncoder)new PngBitmapEncoder() 
                        : new JpegBitmapEncoder();
                        
                    encoder.Frames.Add(BitmapFrame.Create(rtb));
                    using var stream = File.Create(saveFileDialog.FileName);
                    encoder.Save(stream);
                    
                    StatusLabel.Text = $"Saved image: {Path.GetFileName(saveFileDialog.FileName)}";
                    System.Windows.MessageBox.Show("Edited image saved successfully!", "Success", MessageBoxButton.OK, MessageBoxImage.Information);
                }
                catch (Exception ex)
                {
                    System.Windows.MessageBox.Show($"Failed to save image: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }

        private void ExportCSV_Click(object sender, RoutedEventArgs e)
        {
            if (_regions.Count == 0 || _ocrEngine == null)
            {
                System.Windows.MessageBox.Show("No data to export.", "Export", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var saveFileDialog = new Microsoft.Win32.SaveFileDialog
            {
                Filter = "CSV File|*.csv",
                FileName = string.IsNullOrEmpty(_currentImagePath) ? "export.csv" : Path.GetFileNameWithoutExtension(_currentImagePath) + "_export.csv"
            };

            if (saveFileDialog.ShowDialog() == true)
            {
                try
                {
                    var options = new System.Text.Json.JsonSerializerOptions { WriteIndented = false };
                    string jsonState = System.Text.Json.JsonSerializer.Serialize(_regions, options);
                    
                    string? csvData = OCREngineInterop.ExportToCSV(jsonState);
                    if (csvData != null)
                    {
                        File.WriteAllText(saveFileDialog.FileName, csvData, System.Text.Encoding.UTF8);
                        StatusLabel.Text = $"Exported to CSV: {Path.GetFileName(saveFileDialog.FileName)}";
                        System.Windows.MessageBox.Show("Data exported to CSV successfully!", "Success", MessageBoxButton.OK, MessageBoxImage.Information);
                    }
                    else
                    {
                        System.Windows.MessageBox.Show("Failed to generate CSV data.", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                    }
                }
                catch (Exception ex)
                {
                    System.Windows.MessageBox.Show($"Failed to export CSV: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }

        private void ExportPDF_Click(object sender, RoutedEventArgs e)
        {
            if (_regions.Count == 0 || _ocrEngine == null || _currentImagePath == null)
            {
                System.Windows.MessageBox.Show("No image or data to export to PDF.", "Export", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            var saveFileDialog = new Microsoft.Win32.SaveFileDialog
            {
                Filter = "PDF File|*.pdf",
                FileName = Path.GetFileNameWithoutExtension(_currentImagePath) + "_searchable.pdf"
            };

            if (saveFileDialog.ShowDialog() == true)
            {
                try
                {
                    var options = new System.Text.Json.JsonSerializerOptions { WriteIndented = false };
                    string jsonState = System.Text.Json.JsonSerializer.Serialize(_regions, options);
                    
                    bool success = OCREngineInterop.ExportToPDF(_currentImagePath, jsonState, saveFileDialog.FileName);
                    if (success)
                    {
                        StatusLabel.Text = $"Exported to Searchable PDF: {Path.GetFileName(saveFileDialog.FileName)}";
                        System.Windows.MessageBox.Show("Data exported to Searchable PDF successfully!", "Success", MessageBoxButton.OK, MessageBoxImage.Information);
                    }
                    else
                    {
                        System.Windows.MessageBox.Show("Failed to generate PDF file.", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                    }
                }
                catch (Exception ex)
                {
                    System.Windows.MessageBox.Show($"Failed to export PDF: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
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
