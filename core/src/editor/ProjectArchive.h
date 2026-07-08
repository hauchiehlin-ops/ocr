#pragma once

#include <string>
#include <vector>

class ProjectArchive {
public:
    ProjectArchive() = default;
    ~ProjectArchive() = default;

    // Save project state (.ocrproj)
    // imagePath: Path to the original or edited image to bundle
    // jsonState: The serialized JSON state of the text layers
    // outputPath: The target .ocrproj file path
    bool saveProject(const std::string& imagePath, const std::string& jsonState, const std::string& outputPath);

    // Load project state from .ocrproj
    // inputPath: The .ocrproj file path
    // outImagePath: Where to extract the image to
    // outJsonState: Extracted JSON state
    bool loadProject(const std::string& inputPath, std::string& outImagePath, std::string& outJsonState);
};
