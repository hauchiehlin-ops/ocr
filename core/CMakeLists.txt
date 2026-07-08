cmake_minimum_required(VERSION 3.20)
project(ocr_core VERSION 1.0.0 LANGUAGES CXX C)

# ============================================================
# OCR Core Engine — Unified C++ Library
# ============================================================
# Builds a single shared/static library containing:
#   - Image Preprocessing (OpenCV)
#   - OCR Recognition (PaddleOCR v5 via ONNX Runtime)
#   - AI Text Inpainting (LaMa via ONNX Runtime)
#   - Editable Text Layer Management
#   - License Validation (Ed25519)
#
# Supported targets: iOS, Android, macOS, Windows
# ============================================================

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# ---- Platform Detection ----
if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    set(OCR_PLATFORM "IOS")
    set(OCR_MOBILE ON)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
    set(OCR_PLATFORM "ANDROID")
    set(OCR_MOBILE ON)
elseif(APPLE)
    set(OCR_PLATFORM "MACOS")
    set(OCR_MOBILE OFF)
elseif(WIN32)
    set(OCR_PLATFORM "WINDOWS")
    set(OCR_MOBILE OFF)
else()
    set(OCR_PLATFORM "LINUX")
    set(OCR_MOBILE OFF)
endif()

message(STATUS "Building OCR Core for platform: ${OCR_PLATFORM}")
message(STATUS "Mobile build: ${OCR_MOBILE}")

# ---- Build Options ----
option(OCR_BUILD_SHARED    "Build shared library"           ON)
option(OCR_BUILD_TESTS     "Build unit tests"               OFF)
option(OCR_ENABLE_GPU      "Enable GPU acceleration"        OFF)
option(OCR_ENABLE_INPAINT  "Enable LaMa Inpainting module" ON)
option(OCR_ENABLE_LICENSE  "Enable license validation"      ON)
option(OCR_ENABLE_LLM      "Enable Local LLM via llama.cpp" ON)

# ---- Third-Party Dependencies ----
include(FetchContent)

# OpenCV — Image preprocessing
find_package(OpenCV QUIET COMPONENTS core imgproc imgcodecs)
if(NOT OpenCV_FOUND)
    message(WARNING "OpenCV not found. Will attempt to use bundled version.")
    set(OPENCV_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/opencv")
endif()

# ONNX Runtime — Unified ML inference engine
set(ONNXRUNTIME_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/onnxruntime"
    CACHE PATH "Path to ONNX Runtime installation")

if(EXISTS "${ONNXRUNTIME_DIR}/include/onnxruntime_cxx_api.h")
    message(STATUS "Found ONNX Runtime at: ${ONNXRUNTIME_DIR}")
else()
    message(WARNING "ONNX Runtime not found at ${ONNXRUNTIME_DIR}. "
                    "Please download and extract to third_party/onnxruntime/")
endif()

# llama.cpp — Local LLM engine
if(OCR_ENABLE_LLM)
    message(STATUS "Fetching llama.cpp for Local LLM Support...")
    # Disable llama.cpp's internal tests and executables to speed up build
    set(LLAMA_BUILD_TESTS OFF CACHE BOOL "Disable llama.cpp tests" FORCE)
    set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "Disable llama.cpp examples" FORCE)
    set(LLAMA_BUILD_SERVER OFF CACHE BOOL "Disable llama.cpp server" FORCE)
    
    if(OCR_PLATFORM STREQUAL "MACOS" OR OCR_PLATFORM STREQUAL "IOS")
        set(LLAMA_METAL ON CACHE BOOL "Enable Metal for llama.cpp" FORCE)
    endif()

    FetchContent_Declare(
        llama_cpp
        GIT_REPOSITORY https://github.com/ggerganov/llama.cpp.git
        GIT_TAG        master
    )
    FetchContent_MakeAvailable(llama_cpp)
endif()

# ---- Source Files ----
set(OCR_CORE_SOURCES
    # Preprocessor
    src/preprocessor/deskew.cpp
    src/preprocessor/denoise.cpp
    src/preprocessor/binarize.cpp
    src/preprocessor/edge_crop.cpp
    src/preprocessor/preprocessor.cpp

    # OCR Engine
    src/ocr/paddle_ocr_engine.cpp
    src/ocr/text_block.cpp
    src/ocr/context_corrector.cpp

    # Text Layer Editor
    src/editor/text_layer.cpp
    src/editor/text_renderer.cpp
    src/editor/compositor.cpp
    src/editor/ProjectArchive.cpp

    # Core API
    src/ocr_core_api.cpp
    src/SettingsManager.cpp

    # Document Parser
    src/parser/document_parser.cpp

    # History Manager (SQLite)
    third_party/sqlite/sqlite3.c
    src/history/DocumentHistoryManager.cpp
)

# Optional: Local LLM Support
if(OCR_ENABLE_LLM)
    list(APPEND OCR_CORE_SOURCES
        src/llm/LocalLLMEngine.cpp
    )
    add_definitions(-DOCR_ENABLE_LLM=1)
endif()

# Optional: Inpainting module
if(OCR_ENABLE_INPAINT)
    list(APPEND OCR_CORE_SOURCES
        src/inpainting/lama_engine.cpp
        src/inpainting/mask_generator.cpp
        src/inpainting/blender.cpp
    )
    add_definitions(-DOCR_ENABLE_INPAINT=1)
endif()

# Optional: License validation
if(OCR_ENABLE_LICENSE)
    list(APPEND OCR_CORE_SOURCES
        src/license/license_validator.cpp
        src/license/device_fingerprint.cpp
    )
    add_definitions(-DOCR_ENABLE_LICENSE=1)
endif()

# ---- Library Target ----
if(OCR_BUILD_SHARED)
    add_library(ocr_core SHARED ${OCR_CORE_SOURCES})
    target_compile_definitions(ocr_core PRIVATE OCR_CORE_EXPORTS=1)
else()
    add_library(ocr_core STATIC ${OCR_CORE_SOURCES})
endif()

target_include_directories(ocr_core
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
        ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sqlite
        ${ONNXRUNTIME_DIR}/include
)

# ---- Link Dependencies ----
if(OpenCV_FOUND)
    target_link_libraries(ocr_core PRIVATE ${OpenCV_LIBS})
    target_include_directories(ocr_core PRIVATE ${OpenCV_INCLUDE_DIRS})
endif()

# ONNX Runtime libraries
if(EXISTS "${ONNXRUNTIME_DIR}/lib")
    target_link_directories(ocr_core PRIVATE "${ONNXRUNTIME_DIR}/lib")
    target_link_libraries(ocr_core PRIVATE onnxruntime)
endif()

# llama.cpp
if(OCR_ENABLE_LLM)
    target_link_libraries(ocr_core PRIVATE llama ggml)
endif()

# Platform-specific libraries
if(OCR_PLATFORM STREQUAL "MACOS")
    target_link_libraries(ocr_core PRIVATE
        "-framework Foundation"
        "-framework CoreGraphics"
        "-framework Metal"
    )
elseif(OCR_PLATFORM STREQUAL "IOS")
    target_link_libraries(ocr_core PRIVATE
        "-framework Foundation"
        "-framework CoreGraphics"
        "-framework CoreML"
        "-framework Metal"
    )
elseif(OCR_PLATFORM STREQUAL "ANDROID")
    find_library(ANDROID_LOG_LIB log)
    find_library(ANDROID_JNIGRAPHICS_LIB jnigraphics)
    target_link_libraries(ocr_core PRIVATE
        ${ANDROID_LOG_LIB}
        ${ANDROID_JNIGRAPHICS_LIB}
    )
elseif(OCR_PLATFORM STREQUAL "WINDOWS")
    target_link_libraries(ocr_core PRIVATE
        d3d12 dxgi
    )
endif()

# ---- Compiler Flags ----
if(MSVC)
    target_compile_options(ocr_core PRIVATE /W4 /O2 /utf-8)
else()
    target_compile_options(ocr_core PRIVATE -Wall -Wextra -O2)
    if(OCR_MOBILE)
        target_compile_options(ocr_core PRIVATE -ffunction-sections -fdata-sections)
    endif()
endif()

# ---- GPU Acceleration ----
if(OCR_ENABLE_GPU)
    if(OCR_PLATFORM STREQUAL "MACOS" OR OCR_PLATFORM STREQUAL "IOS")
        add_definitions(-DOCR_GPU_METAL=1)
    elseif(OCR_PLATFORM STREQUAL "WINDOWS")
        add_definitions(-DOCR_GPU_DIRECTML=1)
    elseif(OCR_PLATFORM STREQUAL "ANDROID")
        add_definitions(-DOCR_GPU_NNAPI=1)
    endif()
endif()

# ---- Model Files (Copy to build dir) ----
set(OCR_MODEL_DIR "${CMAKE_CURRENT_SOURCE_DIR}/models")
if(EXISTS "${OCR_MODEL_DIR}")
    file(GLOB OCR_MODEL_FILES "${OCR_MODEL_DIR}/*.onnx")
    foreach(MODEL_FILE ${OCR_MODEL_FILES})
        get_filename_component(MODEL_NAME ${MODEL_FILE} NAME)
        configure_file(${MODEL_FILE} ${CMAKE_BINARY_DIR}/models/${MODEL_NAME} COPYONLY)
    endforeach()
endif()

# ---- Install Rules ----
install(TARGETS ocr_core
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
    RUNTIME DESTINATION bin
)
install(FILES include/ocr_core_api.h DESTINATION include)

# ---- Tests ----
if(OCR_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

# ---- Print Summary ----
message(STATUS "")
message(STATUS "============================================")
message(STATUS "  OCR Core Engine Build Configuration")
message(STATUS "============================================")
message(STATUS "  Platform:     ${OCR_PLATFORM}")
message(STATUS "  Shared lib:   ${OCR_BUILD_SHARED}")
message(STATUS "  GPU accel:    ${OCR_ENABLE_GPU}")
message(STATUS "  Inpainting:   ${OCR_ENABLE_INPAINT}")
message(STATUS "  License:      ${OCR_ENABLE_LICENSE}")
message(STATUS "  OpenCV:       ${OpenCV_FOUND}")
message(STATUS "  ONNX Runtime: ${ONNXRUNTIME_DIR}")
message(STATUS "============================================")
