#include "ocr_core_api.h"
#include "ocr/context_corrector.h"
#include "inpainting/mask_generator.h"
#include "preprocessor/preprocessor.h"
#include <iostream>
#include <cassert>
#include <cstring>
#include <cmath>

int main() {
    std::cout << "Starting OCR Core API Linkage Test..." << std::endl;

    // Test version
    const char* version = ocr_version();
    std::cout << "OCR Core Version: " << version << std::endl;
    assert(std::strcmp(version, "1.0.0") == 0);

    // Test bbox helper
    OCRBBox box = ocr_bbox_from_rect(10.0f, 20.0f, 100.0f, 50.0f);
    assert(box.top_left[0] == 10.0f);
    assert(box.top_left[1] == 20.0f);
    assert(box.top_right[0] == 110.0f);
    assert(box.top_right[1] == 20.0f);
    assert(box.bottom_right[0] == 110.0f);
    assert(box.bottom_right[1] == 70.0f);
    assert(box.bottom_left[0] == 10.0f);
    assert(box.bottom_left[1] == 70.0f);
    std::cout << "ocr_bbox_from_rect helper validation: PASSED" << std::endl;

    // 1. Test ContextCorrector
    {
        ocr::ContextCorrector corrector;
        std::string word1 = corrector.correctWord("He11o", 0.8f);
        assert(word1 == "Hello");
        std::string word2 = corrector.correctWord("0CR", 0.7f);
        assert(word2 == "OCR");
        std::string word3 = corrector.correctWord("2O26", 0.6f);
        assert(word3 == "2026");
        std::cout << "ContextCorrector unit validation: PASSED" << std::endl;
    }

    // 2. Test MaskGenerator scanline polygon fill
    {
        OCRBBox rot_box;
        rot_box.top_left[0] = 10.0f; rot_box.top_left[1] = 10.0f;
        rot_box.top_right[0] = 50.0f; rot_box.top_right[1] = 20.0f;
        rot_box.bottom_right[0] = 40.0f; rot_box.bottom_right[1] = 60.0f;
        rot_box.bottom_left[0] = 0.0f; rot_box.bottom_left[1] = 50.0f;

        ocr::MaskGenerator generator;
        ocr::Image mask = generator.generateMask(100, 100, &rot_box, 1, 2);
        assert(!mask.empty());
        bool has_fill = false;
        for (int y = 0; y < 100; y++) {
            for (int x = 0; x < 100; x++) {
                if (mask.pixel(x, y)[0] == 255) {
                    has_fill = true;
                    break;
                }
            }
        }
        assert(has_fill);
        std::cout << "MaskGenerator polygon scanline fill validation: PASSED" << std::endl;
    }

    // 3. Test Preprocessor Sauvola adaptive binarization
    {
        ocr::PreprocessorConfig config;
        config.enable_binarize = true;
        ocr::Preprocessor prep(config);
        ocr::Image input_img(50, 50, 4);
        for (int y = 0; y < 50; y++) {
            for (int x = 0; x < 50; x++) {
                uint8_t* px = input_img.pixel(x, y);
                px[0] = px[1] = px[2] = (x < 25) ? 100 : 200;
                px[3] = 255;
            }
        }
        ocr::Image binarized = prep.process(input_img);
        assert(!binarized.empty());
        assert(binarized.pixel(5, 5)[0] == 0);
        assert(binarized.pixel(45, 45)[0] == 255);
        std::cout << "Preprocessor Sauvola adaptive binarization validation: PASSED" << std::endl;
    }

    // Test engine lifecycle in mock mode
    // Note: since we pass a dummy path and models don't exist, it should load in mock mode and succeed!
    OCRHandle* handle = ocr_engine_create(".", nullptr);
    if (!handle) {
        std::cerr << "ocr_engine_create returned NULL!" << std::endl;
        return 1;
    }
    std::cout << "ocr_engine_create: SUCCESS" << std::endl;

    assert(ocr_is_ready(handle) == 1);
    std::cout << "ocr_is_ready verification: PASSED" << std::endl;

    // Test recognition mock
    uint8_t dummy_pixels[100 * 100 * 4] = {0};
    const char* json = ocr_recognize(handle, dummy_pixels, 100, 100, 4);
    if (!json) {
        std::cerr << "ocr_recognize returned NULL!" << std::endl;
        ocr_engine_destroy(handle);
        return 1;
    }
    std::cout << "ocr_recognize mock output: " << json << std::endl;
    ocr_free_string(json);

    // Test inpaint mock
    OCRBBox remove_box = ocr_bbox_from_rect(10.0f, 10.0f, 20.0f, 20.0f);
    OCRImageResult* remove_res = ocr_remove_text(handle, dummy_pixels, 100, 100, 4, &remove_box, 1);
    if (!remove_res) {
        std::cerr << "ocr_remove_text returned NULL!" << std::endl;
        ocr_engine_destroy(handle);
        return 1;
    }
    std::cout << "ocr_remove_text: SUCCESS" << std::endl;
    ocr_free_image_result(remove_res);

    // Test replace mock
    OCRImageResult* replace_res = ocr_replace_text(handle, dummy_pixels, 100, 100, 4, &remove_box, "Hello", nullptr);
    if (!replace_res) {
        std::cerr << "ocr_replace_text returned NULL!" << std::endl;
        ocr_engine_destroy(handle);
        return 1;
    }
    std::cout << "ocr_replace_text: SUCCESS" << std::endl;
    ocr_free_image_result(replace_res);

    // Test PPTX parsing
    const char* pptx_json = ocr_parse_pptx(handle, "mock_test.pptx");
    assert(pptx_json != nullptr);
    assert(std::strstr(pptx_json, "slides") != nullptr);
    assert(std::strstr(pptx_json, "layers") != nullptr);
    std::cout << "ocr_parse_pptx test validation: PASSED" << std::endl;
    ocr_free_string(pptx_json);

    // Test canvas replace layer image
    uint8_t new_layer_pixels[10 * 10 * 4] = {0};
    int replace_success = ocr_canvas_replace_layer_image(handle, "slide1_bg", new_layer_pixels, 10, 10);
    assert(replace_success == 1);
    std::cout << "ocr_canvas_replace_layer_image test validation: PASSED" << std::endl;

    // Test destruction
    ocr_engine_destroy(handle);
    std::cout << "ocr_engine_destroy: SUCCESS" << std::endl;

    std::cout << "All API Linkage Tests: PASSED!" << std::endl;
    return 0;
}
