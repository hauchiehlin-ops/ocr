using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;
using OCREditor.Interop;

namespace OCREditor
{
    public partial class MainWindow : Window
    {
        private OCREngineInterop? _ocrEngine;
        private string? _currentImagePath;
        private string? _initErrorMessage;

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
            public double RelWidth { get; set; }
            public double RelHeight { get; set; }
            
            public bool IsRemoved { get; set; }
            public bool IsEdited { get; set; }
            
            // Visual elements
            public System.Windows.Controls.Border? BorderElement { get; set; }
            public System.Windows.Controls.TextBlock? TextVisual { get; set; }
        }

        private List<OCRRegion> _regions = new List<OCRRegion>();
        private OCRRegion? _selectedRegion;
        private bool _isUpdatingTextFromSelection = false;

        public MainWindow()
        {
            InitializeComponent();
            InitializeEngine();
        }

        private void InitializeEngine()
        {
            try
            {
                // Look for models directory in common locations
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string modelsPath = Path.Combine(baseDir, "models");

                if (!Directory.Exists(modelsPath))
                {
                    _initErrorMessage = "Models folder not found. Running in Sandbox Mode.";
                    StatusLabel.Text = _initErrorMessage;
                    return;
                }

                _ocrEngine = new OCREngineInterop(modelsPath);
                StatusLabel.Text = "OCR Core Engine initialized successfully.";
            }
            catch (Exception ex)
            {
                _initErrorMessage = $"Engine load error: {ex.Message}. Running in Sandbox Mode.";
                StatusLabel.Text = _initErrorMessage;
            }
        }

        private void OpenImage_Click(object sender, RoutedEventArgs e)
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
                    
                    // Load image
                    var bitmapUri = new Uri(_currentImagePath);
                    var bitmapImage = new BitmapImage(bitmapUri);
                    SourceImage.Source = bitmapImage;
                    
                    StatusLabel.Text = $"Loaded: {Path.GetFileName(_currentImagePath)}";
                    
                    // Initialize dimensions immediately from the image metadata
                    _imgWidth = bitmapImage.Width;
                    _imgHeight = bitmapImage.Height;
                    
                    OverlayCanvas.Width = _imgWidth;
                    OverlayCanvas.Height = _imgHeight;
                    
                    // Clear previous overlays
                    _regions.Clear();
                    _selectedRegion = null;
                    OcrTextBox.Text = string.Empty;
                    OverlayCanvas.Children.Clear();
                    
                    RunOCR();
                }
                catch (Exception ex)
                {
                    MessageBox.Show($"Failed to load image: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                }
            }
        }

        private void RunOCR()
        {
            if (_currentImagePath == null) return;

            if (_ocrEngine != null)
            {
                // Real OCR Engine mode
                try
                {
                    StatusLabel.Text = "Running OCR...";
                    using var bitmap = new Bitmap(_currentImagePath);
                    var result = _ocrEngine.Recognize(bitmap);

                    if (result != null)
                    {
                        OcrTextBox.Text = result.FullText;
                        StatusLabel.Text = $"OCR Complete. Found {result.WordCount} words.";
                        
                        // Parse real boxes
                        _regions.Clear();
                        
                        foreach (var block in result.Blocks)
                        {
                            foreach (var line in block.Lines)
                            {
                                var box = line.BoundingBox;
                                _regions.Add(new OCRRegion
                                {
                                    OriginalText = line.Text,
                                    CurrentText = line.Text,
                                    RelX = box.X / bitmap.Width,
                                    RelY = box.Y / bitmap.Height,
                                    RelWidth = box.Width / bitmap.Width,
                                    RelHeight = box.Height / bitmap.Height
                                });
                            }
                        }
                        
                        RenderRegions();
                    }
                    else
                    {
                        OcrTextBox.Text = string.Empty;
                        StatusLabel.Text = "OCR failed to return results.";
                    }
                }
                catch (Exception ex)
                {
                    StatusLabel.Text = $"OCR error: {ex.Message}";
                    MessageBox.Show($"OCR Core failed: {ex.Message}\nFalling back to Sandbox Mode.", "OCR Warning", MessageBoxButton.OK, MessageBoxImage.Warning);
                    RunMockOCR();
                }
            }
            else
            {
                // Fallback to Interactive Sandbox Mode
                RunMockOCR();
            }
        }

        private void RunMockOCR()
        {
            StatusLabel.Text = "Running in Interactive Sandbox Mode. Click regions on the image to edit/remove.";
            InitializeMockRegions();
            RenderRegions();
        }

        private void InitializeMockRegions()
        {
            _regions.Clear();
            _selectedRegion = null;
            
            // Generate mock regions mapping to the default OCR tutorial image
            _regions.Add(new OCRRegion { OriginalText = "公平正義", CurrentText = "公平正義", RelX = 0.15, RelY = 0.35, RelWidth = 0.22, RelHeight = 0.08 });
            _regions.Add(new OCRRegion { OriginalText = "有效率", CurrentText = "有效率", RelX = 0.40, RelY = 0.35, RelWidth = 0.18, RelHeight = 0.08 });
            _regions.Add(new OCRRegion { OriginalText = "創造公共價值", CurrentText = "創造公共價值", RelX = 0.60, RelY = 0.35, RelWidth = 0.30, RelHeight = 0.08 });
            
            _regions.Add(new OCRRegion { 
                OriginalText = "在施政公平正義原則下，以有效率方式達成預期施政目標並創造公共價值。", 
                CurrentText = "在施政公平正義原則下，以有效率方式達成預期施政目標並創造公共價值。", 
                RelX = 0.12, RelY = 0.47, RelWidth = 0.76, RelHeight = 0.14 
            });
            
            _regions.Add(new OCRRegion { OriginalText = "目標導向\n(施政/關鍵目標)", CurrentText = "目標導向\n(施政/關鍵目標)", RelX = 0.10, RelY = 0.82, RelWidth = 0.23, RelHeight = 0.15 });
            _regions.Add(new OCRRegion { OriginalText = "系統性管理過程\n(檢討修正與因應)", CurrentText = "系統性管理過程\n(檢討修正與因應)", RelX = 0.35, RelY = 0.82, RelWidth = 0.27, RelHeight = 0.15 });
            _regions.Add(new OCRRegion { OriginalText = "管理配套\n(雙控機制、追蹤)", CurrentText = "管理配套\n(雙控機制、追蹤)", RelX = 0.64, RelY = 0.82, RelWidth = 0.24, RelHeight = 0.15 });
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
            
            foreach (var region in _regions)
            {
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
                
                if (region == _selectedRegion)
                {
                    border.BorderBrush = System.Windows.Media.Brushes.DodgerBlue;
                    border.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(40, 30, 144, 255));
                }
                else
                {
                    border.BorderBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(60, 0, 122, 204));
                }
                
                border.MouseEnter += (s, e) =>
                {
                    if (region != _selectedRegion)
                    {
                        border.BorderBrush = System.Windows.Media.Brushes.DeepSkyBlue;
                        border.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(20, 0, 191, 255));
                    }
                };
                border.MouseLeave += (s, e) =>
                {
                    if (region != _selectedRegion)
                    {
                        border.BorderBrush = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(60, 0, 122, 204));
                        border.Background = System.Windows.Media.Brushes.Transparent;
                    }
                };
                border.MouseDown += (s, e) =>
                {
                    SelectRegion(region);
                    e.Handled = true;
                };
                
                if (region.IsRemoved)
                {
                    // Simulated inpainting background (off-white matching standard background)
                    border.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(243, 244, 246));
                    border.BorderThickness = new Thickness(0);
                }
                else if (region.IsEdited)
                {
                    // Simulated replacement text overlay
                    border.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(243, 244, 246));
                    border.BorderThickness = new Thickness(0);
                    
                    var textBlock = new System.Windows.Controls.TextBlock
                    {
                        Text = region.CurrentText,
                        Foreground = System.Windows.Media.Brushes.Black,
                        FontFamily = new System.Windows.Media.FontFamily("Microsoft JhengHei"),
                        FontSize = Math.Max(8, height * 0.55),
                        FontWeight = FontWeights.Bold,
                        VerticalAlignment = VerticalAlignment.Center,
                        HorizontalAlignment = HorizontalAlignment.Center,
                        TextAlignment = TextAlignment.Center
                    };
                    border.Child = textBlock;
                    region.TextVisual = textBlock;
                }
                
                region.BorderElement = border;
                
                Canvas.SetLeft(border, left);
                Canvas.SetTop(border, top);
                OverlayCanvas.Children.Add(border);
            }
        }

        private void SelectRegion(OCRRegion region)
        {
            _selectedRegion = region;
            
            _isUpdatingTextFromSelection = true;
            OcrTextBox.Text = region.CurrentText;
            _isUpdatingTextFromSelection = false;
            
            StatusLabel.Text = $"Selected text region. Edit it in the panel or click 'Remove Text'.";
            RenderRegions();
        }

        private void OcrTextBox_TextChanged(object sender, TextChangedEventArgs e)
        {
            if (_isUpdatingTextFromSelection || _selectedRegion == null) return;
            
            _selectedRegion.CurrentText = OcrTextBox.Text;
            _selectedRegion.IsEdited = true;
            _selectedRegion.IsRemoved = string.IsNullOrWhiteSpace(_selectedRegion.CurrentText);
            
            RenderRegions();
        }

        private void RemoveText_Click(object sender, RoutedEventArgs e)
        {
            if (_selectedRegion != null)
            {
                _selectedRegion.IsRemoved = true;
                _selectedRegion.IsEdited = false;
                _selectedRegion.CurrentText = "";
                
                _isUpdatingTextFromSelection = true;
                OcrTextBox.Text = "";
                _isUpdatingTextFromSelection = false;
                
                StatusLabel.Text = "Text region removed (Inpainting simulated).";
                RenderRegions();
            }
            else
            {
                MessageBox.Show("Please click on a text region on the image first to select it.", "Inpainting", MessageBoxButton.OK, MessageBoxImage.Information);
            }
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
                    // Temporarily deselect outline for rendering/saving
                    var tempSelected = _selectedRegion;
                    _selectedRegion = null;
                    RenderRegions();
                    
                    // Capture layout to bitmap
                    double width = CanvasGrid.ActualWidth;
                    double height = CanvasGrid.ActualHeight;
                    var rtb = new RenderTargetBitmap((int)width, (int)height, 96, 96, PixelFormats.Pbgra32);
                    rtb.Render(CanvasGrid);
                    
                    // Restore outline
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
