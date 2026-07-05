#include "document_parser.h"
#include <sstream>

namespace ocr {

std::string DocumentParser::parsePptx(const std::string& pptx_path) const {
    // Simulated/Mock PPTX parsing outputs valid structured layers JSON.
    // In a real production build, this would use a ZIP/XML parser to read pptx archives.
    
    std::stringstream ss;
    ss << "{\n"
       << "  \"slides\": [\n"
       << "    {\n"
       << "      \"slide_number\": 1,\n"
       << "      \"width\": 1920,\n"
       << "      \"height\": 1080,\n"
       << "      \"layers\": [\n"
       << "        {\n"
       << "          \"id\": \"slide1_bg\",\n"
       << "          \"type\": \"image\",\n"
       << "          \"name\": \"簡報底圖\",\n"
       << "          \"bbox\": {\n"
       << "            \"top_left\": [0.0, 0.0],\n"
       << "            \"top_right\": [1920.0, 0.0],\n"
       << "            \"bottom_right\": [1920.0, 1080.0],\n"
       << "            \"bottom_left\": [0.0, 1080.0]\n"
       << "          },\n"
       << "          \"image_path\": \"ppt/media/image1.png\"\n"
       << "        },\n"
       << "        {\n"
       << "          \"id\": \"slide1_title\",\n"
       << "          \"type\": \"text\",\n"
       << "          \"name\": \"標題文字框\",\n"
       << "          \"text\": \"離線文件圖層編輯器\",\n"
       << "          \"bbox\": {\n"
       << "            \"top_left\": [200.0, 150.0],\n"
       << "            \"top_right\": [1720.0, 150.0],\n"
       << "            \"bottom_right\": [1720.0, 300.0],\n"
       << "            \"bottom_left\": [200.0, 300.0]\n"
       << "          },\n"
       << "          \"font_size\": 48.0,\n"
       << "          \"font_color\": [50, 50, 50],\n"
       << "          \"is_bold\": true\n"
       << "        },\n"
       << "        {\n"
       << "          \"id\": \"slide1_subtitle\",\n"
       << "          \"type\": \"text\",\n"
       << "          \"name\": \"副標題文字框\",\n"
       << "          \"text\": \"支援圖層分離、富文字格式與元件替換之完整畫布工作流\",\n"
       << "          \"bbox\": {\n"
       << "            \"top_left\": [200.0, 350.0],\n"
       << "            \"top_right\": [1720.0, 350.0],\n"
       << "            \"bottom_right\": [1720.0, 450.0],\n"
       << "            \"bottom_left\": [200.0, 450.0]\n"
       << "          },\n"
       << "          \"font_size\": 24.0,\n"
       << "          \"font_color\": [100, 100, 100],\n"
       << "          \"is_bold\": false\n"
       << "        },\n"
       << "        {\n"
       << "          \"id\": \"slide1_icon_presentation\",\n"
       << "          \"type\": \"vector\",\n"
       << "          \"name\": \"簡報圖標\",\n"
       << "          \"bbox\": {\n"
       << "            \"top_left\": [860.0, 550.0],\n"
       << "            \"top_right\": [1060.0, 550.0],\n"
       << "            \"bottom_right\": [1060.0, 750.0],\n"
       << "            \"bottom_left\": [860.0, 750.0]\n"
       << "          }\n"
       << "        }\n"
       << "      ]\n"
       << "    }\n"
       << "  ]\n"
       << "}\n";
    
    return ss.str();
}

} // namespace ocr
