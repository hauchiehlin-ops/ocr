#include "ProjectArchive.h"
#include <fstream>
#include <sstream>
#include <iostream>

#include "ProjectArchive.h"
#include <fstream>
#include <sstream>
#include <iostream>
#include <vector>
#include "../vendor/miniz/miniz.h"

// miniz.c is included in ocr_core_api.cpp unity build if needed, or we just include it here
// Actually, since we're using a unity build, we'll just include miniz.c here for simplicity.
#include "../vendor/miniz/miniz.c"

bool ProjectArchive::saveProject(const std::string& imagePath, const std::string& jsonState, const std::string& outputPath) {
    mz_zip_archive zip_archive;
    memset(&zip_archive, 0, sizeof(zip_archive));

    if (!mz_zip_writer_init_file(&zip_archive, outputPath.c_str(), 0)) {
        return false;
    }

    // Add JSON state
    if (!mz_zip_writer_add_mem(&zip_archive, "state.json", jsonState.c_str(), jsonState.length(), MZ_BEST_COMPRESSION)) {
        mz_zip_writer_end(&zip_archive);
        return false;
    }

    // Read image file into memory
    std::ifstream imgFile(imagePath, std::ios::binary | std::ios::ate);
    if (imgFile.is_open()) {
        std::streamsize size = imgFile.tellg();
        imgFile.seekg(0, std::ios::beg);
        std::vector<char> buffer(size);
        if (imgFile.read(buffer.data(), size)) {
            // Add image file to zip
            // Use the base name of the image for the archive path
            std::string baseName = "image.png"; // Default
            size_t slashPos = imagePath.find_last_of("/\\");
            if (slashPos != std::string::npos) {
                baseName = imagePath.substr(slashPos + 1);
            }
            mz_zip_writer_add_mem(&zip_archive, baseName.c_str(), buffer.data(), size, MZ_BEST_COMPRESSION);
        }
    } else {
        // If we can't open the image, we still save the JSON, but it might be considered an incomplete project.
        // For now, we continue.
    }

    if (!mz_zip_writer_finalize_archive(&zip_archive)) {
        mz_zip_writer_end(&zip_archive);
        return false;
    }

    mz_zip_writer_end(&zip_archive);
    return true;
}

bool ProjectArchive::loadProject(const std::string& inputPath, std::string& outImagePath, std::string& outJsonState) {
    mz_zip_archive zip_archive;
    memset(&zip_archive, 0, sizeof(zip_archive));

    if (!mz_zip_reader_init_file(&zip_archive, inputPath.c_str(), 0)) {
        return false;
    }

    bool foundJson = false;
    bool foundImage = false;

    for (mz_uint i = 0; i < mz_zip_reader_get_num_files(&zip_archive); i++) {
        mz_zip_archive_file_stat file_stat;
        if (!mz_zip_reader_file_stat(&zip_archive, i, &file_stat)) continue;

        std::string filename = file_stat.m_filename;
        
        if (filename == "state.json") {
            size_t uncomp_size;
            void* p = mz_zip_reader_extract_to_heap(&zip_archive, i, &uncomp_size, 0);
            if (p) {
                outJsonState.assign(static_cast<const char*>(p), uncomp_size);
                mz_free(p);
                foundJson = true;
            }
        } else if (filename.find(".png") != std::string::npos || filename.find(".jpg") != std::string::npos || filename.find("image") != std::string::npos) {
            // Extract to temp file
            outImagePath = "/tmp/" + filename; // Simplified temp path
            if (mz_zip_reader_extract_to_file(&zip_archive, i, outImagePath.c_str(), 0)) {
                foundImage = true;
            }
        }
    }

    mz_zip_reader_end(&zip_archive);
    return foundJson; // Image is optional, but JSON is required
}
