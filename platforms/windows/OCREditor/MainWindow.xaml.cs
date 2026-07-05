using System;
using System.Drawing;
using System.IO;
using System.Windows;
using System.Windows.Media.Imaging;
using Microsoft.Win32;
using OCREditor.Interop;

namespace OCREditor
{
    public partial class MainWindow : Window
    {
        private OCREngineInterop? _ocrEngine;
        private string? _currentImagePath;

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
                    StatusLabel.Text = "Models folder not found. Please place models in: " + modelsPath;
                    return;
                }

                _ocrEngine = new OCREngineInterop(modelsPath);
                StatusLabel.Text = "OCR Core Engine initialized successfully.";
            }
            catch (Exception ex)
            {
                StatusLabel.Text = $"Engine load error: {ex.Message}";
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
                    SourceImage.Source = new BitmapImage(new Uri(_currentImagePath));
                    StatusLabel.Text = $"Loaded: {Path.GetFileName(_currentImagePath)}";
                    
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
            if (_ocrEngine == null || _currentImagePath == null) return;

            try
            {
                StatusLabel.Text = "Running OCR...";
                using var bitmap = new Bitmap(_currentImagePath);
                var result = _ocrEngine.Recognize(bitmap);

                if (result != null)
                {
                    OcrTextBox.Text = result.FullText;
                    StatusLabel.Text = $"OCR Complete. Found {result.WordCount} words.";
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
            }
        }

        private void RemoveText_Click(object sender, RoutedEventArgs e)
        {
            MessageBox.Show("Select text in the editor to remove it (Inpainting feature).", "Inpainting", MessageBoxButton.OK, MessageBoxImage.Information);
        }

        private void SaveImage_Click(object sender, RoutedEventArgs e)
        {
            MessageBox.Show("Feature to save edited image will be available in next release.", "Save", MessageBoxButton.OK, MessageBoxImage.Information);
        }

        protected override void OnClosed(EventArgs e)
        {
            _ocrEngine?.Dispose();
            base.OnClosed(e);
        }
    }
}
