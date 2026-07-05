/**
 * @file preprocessor.cpp
 * @brief Image Preprocessor — Full pipeline implementation.
 *
 * Uses OpenCV (when available) for image processing operations.
 * Falls back to basic implementations when OpenCV is not linked.
 */

#include "preprocessor.h"
#include <cmath>
#include <algorithm>
#include <numeric>

namespace ocr {

Preprocessor::Preprocessor(const PreprocessorConfig& config)
    : config_(config) {
}

Preprocessor::~Preprocessor() = default;

Image Preprocessor::process(const Image& input) {
    if (input.empty()) return input;

    Image result = maybeDownscale(input);

    // Execute pipeline steps in order
    if (config_.enable_edge_crop) {
        result = edgeCrop(result);
    }

    if (config_.enable_deskew) {
        result = deskew(result);
    }

    if (config_.enable_denoise) {
        result = denoise(result);
    }

    // Always enhance contrast for better OCR
    result = enhanceContrast(result);

    if (config_.enable_binarize) {
        result = binarize(result);
    }

    return result;
}

Image Preprocessor::maybeDownscale(const Image& input) {
    int max_dim = std::max(input.width(), input.height());
    if (max_dim <= config_.max_dimension) {
        return input; // No downscaling needed
    }

    float scale = static_cast<float>(config_.max_dimension) / max_dim;
    int new_width = static_cast<int>(input.width() * scale);
    int new_height = static_cast<int>(input.height() * scale);

    // Simple bilinear downscale
    Image output(new_width, new_height, input.channels());

    for (int y = 0; y < new_height; y++) {
        for (int x = 0; x < new_width; x++) {
            float src_x = x / scale;
            float src_y = y / scale;

            int x0 = std::min(static_cast<int>(src_x), input.width() - 1);
            int y0 = std::min(static_cast<int>(src_y), input.height() - 1);

            const uint8_t* src_pixel = input.pixel(x0, y0);
            uint8_t* dst_pixel = output.pixel(x, y);

            for (int c = 0; c < input.channels(); c++) {
                dst_pixel[c] = src_pixel[c];
            }
        }
    }

    return output;
}

Image Preprocessor::deskew(const Image& input) {
    // TODO: Implement Hough Line Transform-based deskew
    // Algorithm:
    // 1. Convert to grayscale
    // 2. Apply Canny edge detection
    // 3. Run Hough Line Transform to detect dominant lines
    // 4. Calculate median angle from detected lines
    // 5. Rotate image by negative of that angle
    //
    // When OpenCV is available, use:
    //   cv::HoughLinesP() → compute angle → cv::warpAffine()

    return input; // Passthrough until OpenCV integration
}

Image Preprocessor::denoise(const Image& input) {
    // Simple 3x3 median filter for noise reduction
    // TODO: Replace with OpenCV's cv::fastNlMeansDenoising() for better results

    if (input.width() < 3 || input.height() < 3) return input;

    Image output(input.width(), input.height(), input.channels());

    for (int y = 1; y < input.height() - 1; y++) {
        for (int x = 1; x < input.width() - 1; x++) {
            for (int c = 0; c < input.channels(); c++) {
                // Collect 3x3 neighborhood
                uint8_t values[9];
                int idx = 0;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        values[idx++] = input.pixel(x + dx, y + dy)[c];
                    }
                }
                // Median of 9 values
                std::sort(values, values + 9);
                output.pixel(x, y)[c] = values[4];
            }
        }
    }

    // Copy border pixels unchanged
    for (int x = 0; x < input.width(); x++) {
        std::memcpy(output.pixel(x, 0), input.pixel(x, 0), input.channels());
        std::memcpy(output.pixel(x, input.height() - 1),
                    input.pixel(x, input.height() - 1), input.channels());
    }
    for (int y = 0; y < input.height(); y++) {
        std::memcpy(output.pixel(0, y), input.pixel(0, y), input.channels());
        std::memcpy(output.pixel(input.width() - 1, y),
                    input.pixel(input.width() - 1, y), input.channels());
    }

    return output;
}

Image Preprocessor::binarize(const Image& input) {
    int w = input.width();
    int h = input.height();
    Image output(w, h, input.channels());

    // 1. Compute integral images of luminance and luminance-squared
    // S(x, y) stores sum of pixels in [0, x) and [0, y)
    std::vector<std::vector<double>> S(w + 1, std::vector<double>(h + 1, 0.0));
    std::vector<std::vector<double>> Sq(w + 1, std::vector<double>(h + 1, 0.0));

    for (int y = 0; y < h; y++) {
        double rowSum = 0.0;
        double rowSumSq = 0.0;
        for (int x = 0; x < w; x++) {
            const uint8_t* px = input.pixel(x, y);
            double gray = (px[0] * 299.0 + px[1] * 587.0 + px[2] * 114.0) / 1000.0;
            rowSum += gray;
            rowSumSq += gray * gray;
            S[x + 1][y + 1] = S[x + 1][y] + rowSum;
            Sq[x + 1][y + 1] = Sq[x + 1][y] + rowSumSq;
        }
    }

    // Sauvola parameters
    const int W = 15; // Window size
    const double k = 0.2; // Control parameter [0.2, 0.5]
    const double R = 128.0; // Dynamic range of standard deviation

    // 2. Compute Sauvola threshold for each pixel
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            int x0 = std::max(0, x - W / 2);
            int y0 = std::max(0, y - W / 2);
            int x1 = std::min(w - 1, x + W / 2);
            int y1 = std::min(h - 1, y + W / 2);

            double count = (x1 - x0 + 1) * (y1 - y0 + 1);

            double sum = S[x1 + 1][y1 + 1] - S[x0][y1 + 1] - S[x1 + 1][y0] + S[x0][y0];
            double sumSq = Sq[x1 + 1][y1 + 1] - Sq[x0][y1 + 1] - Sq[x1 + 1][y0] + Sq[x0][y0];

            double mean = sum / count;
            double variance = (sumSq / count) - (mean * mean);
            double stdDev = std::sqrt(std::max(0.0, variance));

            double threshold = mean * (1.0 + k * (stdDev / R - 1.0));

            const uint8_t* src = input.pixel(x, y);
            uint8_t* dst = output.pixel(x, y);
            double gray = (src[0] * 299.0 + src[1] * 587.0 + src[2] * 114.0) / 1000.0;

            uint8_t val = (gray > threshold) ? 255 : 0;
            dst[0] = dst[1] = dst[2] = val;
            dst[3] = src[3]; // Preserve alpha
        }
    }

    return output;
}

Image Preprocessor::edgeCrop(const Image& input) {
    // TODO: Implement contour-based document edge detection
    // Algorithm:
    // 1. Convert to grayscale
    // 2. Apply Gaussian blur
    // 3. Canny edge detection
    // 4. Find contours
    // 5. Find the largest quadrilateral contour
    // 6. Apply perspective transform to extract the document
    //
    // When OpenCV is available, use:
    //   cv::Canny() → cv::findContours() → cv::approxPolyDP() → cv::getPerspectiveTransform()

    return input; // Passthrough until OpenCV integration
}

Image Preprocessor::enhanceContrast(const Image& input) {
    // Simple histogram stretching for contrast enhancement
    // TODO: Replace with CLAHE (cv::createCLAHE()) for adaptive enhancement

    // Find min/max luminance
    uint8_t min_val = 255, max_val = 0;
    for (int y = 0; y < input.height(); y++) {
        for (int x = 0; x < input.width(); x++) {
            const uint8_t* px = input.pixel(x, y);
            uint8_t gray = static_cast<uint8_t>(
                (px[0] * 299 + px[1] * 587 + px[2] * 114) / 1000);
            min_val = std::min(min_val, gray);
            max_val = std::max(max_val, gray);
        }
    }

    if (max_val <= min_val) return input; // No contrast to stretch

    float range = static_cast<float>(max_val - min_val);
    if (range > 200) return input; // Already good contrast

    Image output(input.width(), input.height(), input.channels());

    for (int y = 0; y < input.height(); y++) {
        for (int x = 0; x < input.width(); x++) {
            const uint8_t* src = input.pixel(x, y);
            uint8_t* dst = output.pixel(x, y);

            for (int c = 0; c < 3; c++) { // RGB channels only
                float normalized = (src[c] - min_val) / range;
                float enhanced = normalized * config_.contrast_factor;
                dst[c] = static_cast<uint8_t>(
                    std::min(255.0f, std::max(0.0f, enhanced * 255.0f)));
            }
            dst[3] = src[3]; // Preserve alpha
        }
    }

    return output;
}

} // namespace ocr
