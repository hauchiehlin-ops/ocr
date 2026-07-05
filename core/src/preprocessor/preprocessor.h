/**
 * @file preprocessor.h
 * @brief Image Preprocessor — Optimizes images before OCR recognition.
 *
 * Pipeline:
 *   1. Deskew (rotation correction)
 *   2. Denoise (noise reduction)
 *   3. Binarize (adaptive thresholding)
 *   4. Edge Crop (document boundary detection)
 */

#ifndef OCR_PREPROCESSOR_H
#define OCR_PREPROCESSOR_H

#include <cstdint>
#include <cstddef>
#include <vector>
#include <string>
#include <memory>

namespace ocr {

/**
 * @brief Simple image container used throughout the engine.
 *
 * Owns a copy of pixel data in RGBA format.
 */
class Image {
public:
    Image() : width_(0), height_(0), channels_(0) {}

    Image(const uint8_t* data, int width, int height, int channels)
        : width_(width), height_(height), channels_(channels) {
        size_t size = static_cast<size_t>(width) * height * channels;
        data_.assign(data, data + size);
    }

    Image(int width, int height, int channels)
        : width_(width), height_(height), channels_(channels) {
        data_.resize(static_cast<size_t>(width) * height * channels, 0);
    }

    const uint8_t* data() const { return data_.data(); }
    uint8_t* mutable_data() { return data_.data(); }
    int width() const { return width_; }
    int height() const { return height_; }
    int channels() const { return channels_; }
    size_t size() const { return data_.size(); }
    bool empty() const { return data_.empty(); }

    /// Access pixel at (x, y) — returns pointer to first channel
    uint8_t* pixel(int x, int y) {
        return &data_[(y * width_ + x) * channels_];
    }
    const uint8_t* pixel(int x, int y) const {
        return &data_[(y * width_ + x) * channels_];
    }

private:
    std::vector<uint8_t> data_;
    int width_;
    int height_;
    int channels_;
};

/**
 * @brief Configuration for the preprocessing pipeline.
 */
struct PreprocessorConfig {
    bool enable_deskew   = true;   ///< Auto-rotate skewed images
    bool enable_denoise  = true;   ///< Apply noise reduction filter
    bool enable_binarize = false;  ///< Apply adaptive binarization (for scanned docs)
    bool enable_edge_crop = false; ///< Auto-detect and crop document edges
    int  max_dimension   = 4096;   ///< Max image dimension (downscale if larger)
    float contrast_factor = 1.5f;  ///< CLAHE contrast enhancement factor
};

/**
 * @brief Image Preprocessor — Applies image enhancement before OCR.
 *
 * Usage:
 * @code
 *   ocr::Preprocessor preprocessor;
 *   ocr::Image enhanced = preprocessor.process(raw_image);
 * @endcode
 */
class Preprocessor {
public:
    explicit Preprocessor(const PreprocessorConfig& config = PreprocessorConfig());
    ~Preprocessor();

    // Non-copyable
    Preprocessor(const Preprocessor&) = delete;
    Preprocessor& operator=(const Preprocessor&) = delete;

    /**
     * @brief Run the full preprocessing pipeline on an image.
     *
     * @param input  Raw input image (RGBA).
     * @return Enhanced image optimized for OCR.
     */
    Image process(const Image& input);

    /**
     * @brief Apply only deskew correction.
     */
    Image deskew(const Image& input);

    /**
     * @brief Apply only denoising.
     */
    Image denoise(const Image& input);

    /**
     * @brief Apply only adaptive binarization.
     */
    Image binarize(const Image& input);

    /**
     * @brief Detect and crop document edges.
     */
    Image edgeCrop(const Image& input);

    /**
     * @brief Apply contrast enhancement (CLAHE).
     */
    Image enhanceContrast(const Image& input);

private:
    PreprocessorConfig config_;

    /// Downscale image if it exceeds max_dimension
    Image maybeDownscale(const Image& input);
};

} // namespace ocr

#endif // OCR_PREPROCESSOR_H
