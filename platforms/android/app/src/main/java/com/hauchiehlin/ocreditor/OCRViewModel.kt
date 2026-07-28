package com.hauchiehlin.ocreditor

import android.graphics.Bitmap
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Canvas
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions

data class BoundingBox(val x: Int, val y: Int, val width: Int, val height: Int)
data class FontEstimate(
    val sizePx: Float = 14f,
    val colorRgb: IntArray = intArrayOf(0, 0, 0),
    val isBold: Boolean = false,
    val fontName: String = "PingFang TC"
)
data class TextWord(val text: String, val boundingBox: BoundingBox, val confidence: Double, val fontEstimate: FontEstimate)
data class TextLine(val text: String, val boundingBox: BoundingBox, val confidence: Double, val words: List<TextWord> = emptyList())
data class TextBlock(val lines: List<TextLine>, val boundingBox: BoundingBox)

data class OCRLayer(
    val id: java.util.UUID = java.util.UUID.randomUUID(),
    val originalText: String,
    val currentText: String,
    val boundingBox: BoundingBox,
    val fontSize: Float = 14f,
    val isBold: Boolean = false,
    val isItalic: Boolean = false,
    val fontColor: Int = android.graphics.Color.BLACK,
    val fontFamily: String = "PingFang TC",
    val isRemoved: Boolean = false,
    val isEdited: Boolean = false
)

sealed class OCRState {
    object Idle : OCRState()
    object Loading : OCRState()
    data class Success(val layers: List<OCRLayer>, val rawJson: String) : OCRState()
    data class Error(val message: String) : OCRState()
}

class OCRViewModel : ViewModel() {

    private val _ocrState = MutableStateFlow<OCRState>(OCRState.Idle)
    val ocrState: StateFlow<OCRState> = _ocrState.asStateFlow()

    private var engineInitialized = false

    private val _showModelDownloadPrompt = MutableStateFlow(false)
    val showModelDownloadPrompt: StateFlow<Boolean> = _showModelDownloadPrompt.asStateFlow()

    private val _isDownloadingModels = MutableStateFlow(false)
    val isDownloadingModels: StateFlow<Boolean> = _isDownloadingModels.asStateFlow()

    private val _downloadProgress = MutableStateFlow(0.0)
    val downloadProgress: StateFlow<Double> = _downloadProgress.asStateFlow()

    private val undoStack = mutableListOf<List<OCRLayer>>()
    private val redoStack = mutableListOf<List<OCRLayer>>()

    private val _canUndo = MutableStateFlow(false)
    val canUndo: StateFlow<Boolean> = _canUndo.asStateFlow()

    private val _canRedo = MutableStateFlow(false)
    val canRedo: StateFlow<Boolean> = _canRedo.asStateFlow()

    private val _selectedLayerId = MutableStateFlow<java.util.UUID?>(null)
    val selectedLayerId: StateFlow<java.util.UUID?> = _selectedLayerId.asStateFlow()

    // Font Settings
    val forceComputerFontAfterOCR = MutableStateFlow(false)
    val primaryOCRFont = MutableStateFlow("Noto Sans CJK")
    val secondaryOCRFont = MutableStateFlow("Century Gothic")

    private val _isUsingLightweightModel = MutableStateFlow(true)
    val isUsingLightweightModel: StateFlow<Boolean> = _isUsingLightweightModel.asStateFlow()

    private val _recognizedLanguage = MutableStateFlow("ch_tra,eng")
    val recognizedLanguage: StateFlow<String> = _recognizedLanguage.asStateFlow()

    private var currentModelPath: String = ""
    private var lightweightPathCache: String = ""
    private var autoSaveJob: kotlinx.coroutines.Job? = null

    init {
        startAutoSave()
    }

    private fun startAutoSave() {
        autoSaveJob?.cancel()
        autoSaveJob = viewModelScope.launch(Dispatchers.IO) {
            while(true) {
                kotlinx.coroutines.delay(60_000)
                saveHistory()
            }
        }
    }

    private fun saveHistory() {
        val state = _ocrState.value
        if (state is OCRState.Success) {
            try {
                OCREngineBridge.saveHistoryDocument("android-draft", state.rawJson, "Android Draft", null)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    fun setLanguage(lang: String) {
        _recognizedLanguage.value = lang
        if (engineInitialized) {
            initializeEngine(lightweightPathCache, currentModelPath)
        }
    }

    fun initializeEngine(lightweightModelPath: String, downloadedModelPath: String) {
        currentModelPath = downloadedModelPath
        lightweightPathCache = lightweightModelPath
        
        val configJson = "{\"lang\": \"${_recognizedLanguage.value}\"}"

        viewModelScope.launch(Dispatchers.IO) {
            // 1. 優先嘗試載入高精度完整模型
            val downloadedFile = java.io.File(downloadedModelPath, "ppocr_det_v5.onnx")
            if (downloadedFile.exists() && try { OCREngineBridge.initEngine(downloadedModelPath, configJson) } catch (e: Exception) { false }) {
                engineInitialized = true
                _isUsingLightweightModel.value = false
                
                val llmPath = java.io.File(downloadedModelPath, "llm_lightweight.gguf")
                if (llmPath.exists()) OCREngineBridge.loadLLMModel(llmPath.absolutePath)
                return@launch
            }

            // 2. 如果沒有下載高精度模型，降級使用 App 內建的輕量版模型
            val lightweightFile = java.io.File(lightweightModelPath, "ppocr_det_v5.onnx")
            if (lightweightFile.exists() && try { OCREngineBridge.initEngine(lightweightModelPath, configJson) } catch (e: Exception) { false }) {
                engineInitialized = true
                _isUsingLightweightModel.value = true
                
                val llmPath = java.io.File(lightweightModelPath, "llm_lightweight.gguf")
                if (llmPath.exists()) OCREngineBridge.loadLLMModel(llmPath.absolutePath)
                return@launch
            }

            // 3. 都沒有則視為失敗 (不再強制跳出下載提示，預設打包的情境下應該至少有輕量模型)
            engineInitialized = false
            // ML Kit is the working on-device fallback and requires no model button.
            _isUsingLightweightModel.value = false
        }
    }

    fun downloadModels() {
        _ocrState.value = OCRState.Error("目前版本使用裝置端 ML Kit OCR，無須下載額外模型。")
    }

    fun recognizeText(bitmap: Bitmap) {
        _ocrState.value = OCRState.Loading
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val processedBitmap = preprocessBitmap(bitmap)
                val jsonString = if (engineInitialized) OCREngineBridge.recognizeText(processedBitmap) else "{}"
                val layers = parseToLayers(jsonString)

                if (layers.isEmpty()) {
                    recognizeWithMlKit(bitmap)
                    return@launch
                }
                
                undoStack.clear()
                redoStack.clear()
                undoStack.add(layers)
                updateUndoRedoStates()
                _selectedLayerId.value = null
                
                _ocrState.value = OCRState.Success(layers, jsonString)
            } catch (e: Exception) {
                _ocrState.value = OCRState.Error(e.message ?: "Unknown error occurred")
            }
        }
    }

    private fun recognizeWithMlKit(bitmap: Bitmap) {
        val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        recognizer.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { result ->
                val layers = result.textBlocks.flatMap { block ->
                    block.lines.mapNotNull { line ->
                        val rect = line.boundingBox ?: return@mapNotNull null
                        OCRLayer(
                            originalText = line.text,
                            currentText = line.text,
                            boundingBox = BoundingBox(rect.left, rect.top, rect.width(), rect.height()),
                            fontSize = (rect.height() * 0.8f).coerceAtLeast(12f),
                            fontFamily = if (forceComputerFontAfterOCR.value) {
                                if (line.text.matches(Regex("^[a-zA-Z0-9\\s\\p{Punct}]+$"))) secondaryOCRFont.value else primaryOCRFont.value
                            } else "Noto Sans CJK"
                        )
                    }
                }
                if (layers.isEmpty()) {
                    _ocrState.value = OCRState.Error("圖片已開啟，但沒有辨識到任何文字。請確認圖片清晰度、方向與語言。")
                } else {
                    undoStack.clear()
                    redoStack.clear()
                    undoStack.add(layers)
                    updateUndoRedoStates()
                    _selectedLayerId.value = null
                    _ocrState.value = OCRState.Success(layers, layersToJson(layers, bitmap.width, bitmap.height))
                }
                recognizer.close()
            }
            .addOnFailureListener { error ->
                _ocrState.value = OCRState.Error("文字辨識失敗：${error.localizedMessage ?: "未知錯誤"}")
                recognizer.close()
            }
    }

    fun recognizeRegion(bitmap: Bitmap, x: Int, y: Int, w: Int, h: Int) {
        if (w <= 0 || h <= 0) {
            _ocrState.value = OCRState.Error("請選取有效的辨識區域")
            return
        }
        val previousState = _ocrState.value as? OCRState.Success
        _ocrState.value = OCRState.Loading
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val safeX = x.coerceIn(0, bitmap.width - 1)
                val safeY = y.coerceIn(0, bitmap.height - 1)
                val safeW = w.coerceAtMost(bitmap.width - safeX)
                val safeH = h.coerceAtMost(bitmap.height - safeY)
                val crop = Bitmap.createBitmap(bitmap, safeX, safeY, safeW, safeH)
                val recognizer = TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
                recognizer.process(InputImage.fromBitmap(crop, 0))
                    .addOnSuccessListener { result ->
                        val newLayers = result.textBlocks.flatMap { block -> block.lines.mapNotNull { line ->
                            val rect = line.boundingBox ?: return@mapNotNull null
                            OCRLayer(originalText = line.text, currentText = line.text,
                                boundingBox = BoundingBox(rect.left + safeX, rect.top + safeY, rect.width(), rect.height()),
                                fontSize = (rect.height() * 0.8f).coerceAtLeast(12f), fontFamily = "Noto Sans CJK")
                        }}
                        val updatedLayers = (previousState?.layers ?: emptyList()) + newLayers
                        if (newLayers.isEmpty()) {
                            _ocrState.value = previousState ?: OCRState.Error("選取區域內沒有辨識到文字")
                        } else {
                            undoStack.add(updatedLayers)
                            redoStack.clear()
                            updateUndoRedoStates()
                            _ocrState.value = OCRState.Success(updatedLayers, layersToJson(updatedLayers, bitmap.width, bitmap.height))
                        }
                        crop.recycle()
                        recognizer.close()
                    }
                    .addOnFailureListener { error ->
                        crop.recycle()
                        recognizer.close()
                        _ocrState.value = previousState ?: OCRState.Error("區域辨識失敗：${error.localizedMessage}")
                    }
                return@launch
            } catch (e: Exception) {
                _ocrState.value = previousState ?: OCRState.Error(e.message ?: "區域辨識失敗")
            }
        }
    }

    fun closeImage() {
        _ocrState.value = OCRState.Idle
    }

    fun exportToMarkdown(): String? {
        val state = _ocrState.value
        if (state is OCRState.Success) {
            return OCREngineBridge.exportMarkdownFromJson(state.rawJson)
        }
        return null
    }

    fun exportToCSV(): String? {
        val state = _ocrState.value
        if (state is OCRState.Success) {
            return OCREngineBridge.exportCSVFromJson(state.rawJson)
        }
        return null
    }

    fun exportToPDF(context: android.content.Context, uri: android.net.Uri, originalBitmap: android.graphics.Bitmap) {
        val state = _ocrState.value
        if (state !is OCRState.Success) return

        kotlin.concurrent.thread {
            try {
                val pdfDocument = android.graphics.pdf.PdfDocument()
                val pageInfo = android.graphics.pdf.PdfDocument.PageInfo.Builder(
                    originalBitmap.width, originalBitmap.height, 1
                ).create()

                val page = pdfDocument.startPage(pageInfo)
                val canvas = page.canvas

                // 1. Draw Image
                canvas.drawBitmap(originalBitmap, 0f, 0f, null)

                // 2. Draw invisible text (Dual-Layer)
                val textPaint = android.graphics.Paint().apply {
                    color = android.graphics.Color.TRANSPARENT // Invisible
                    typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.NORMAL)
                }

                for (layer in state.layers) {
                    if (layer.isRemoved) continue
                    textPaint.textSize = layer.fontSize
                    textPaint.color = layer.fontColor
                    canvas.drawText(
                        layer.currentText,
                        layer.boundingBox.x.toFloat(),
                        (layer.boundingBox.y + layer.boundingBox.height).toFloat(),
                        textPaint
                    )
                }

                pdfDocument.finishPage(page)

                context.contentResolver.openOutputStream(uri)?.use { outStream ->
                    pdfDocument.writeTo(outStream)
                }
                pdfDocument.close()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    // ============================================================
    // LLM Operations
    // ============================================================

    fun fixTextWithLLM(layerId: java.util.UUID, originalText: String) {
        if (originalText.isBlank()) return
        val currentState = _ocrState.value
        if (currentState !is OCRState.Success) return

        viewModelScope.launch(Dispatchers.IO) {
            val fixedText = OCREngineBridge.fixTextWithLLM(originalText)
            if (!fixedText.isNullOrEmpty()) {
                val layerToUpdate = currentState.layers.find { it.id == layerId }
                if (layerToUpdate != null) {
                    val updatedLayer = layerToUpdate.copy(currentText = fixedText, isEdited = true)
                    updateLayer(layerId, updatedLayer)
                }
            }
        }
    }

    fun translateWithLLM(layerId: java.util.UUID, originalText: String, targetLang: String = "Traditional Chinese") {
        if (originalText.isBlank()) return
        val currentState = _ocrState.value
        if (currentState !is OCRState.Success) return

        viewModelScope.launch(Dispatchers.IO) {
            val translatedText = OCREngineBridge.translateWithLLM(originalText, targetLang)
            if (!translatedText.isNullOrEmpty()) {
                val layerToUpdate = currentState.layers.find { it.id == layerId }
                if (layerToUpdate != null) {
                    val updatedLayer = layerToUpdate.copy(currentText = translatedText, isEdited = true)
                    updateLayer(layerId, updatedLayer)
                }
            }
        }
    }

    fun extractEntitiesWithLLM(layerId: java.util.UUID, originalText: String) {
        if (originalText.isBlank()) return
        val currentState = _ocrState.value
        if (currentState !is OCRState.Success) return

        viewModelScope.launch(Dispatchers.IO) {
            val entitiesText = OCREngineBridge.extractEntitiesWithLLM(originalText)
            if (!entitiesText.isNullOrEmpty()) {
                val layerToUpdate = currentState.layers.find { it.id == layerId }
                if (layerToUpdate != null) {
                    val combined = "【Entities】\n$entitiesText\n\n【Original】\n$originalText"
                    val updatedLayer = layerToUpdate.copy(currentText = combined, isEdited = true)
                    updateLayer(layerId, updatedLayer)
                }
            }
        }
    }

    fun selectLayer(id: java.util.UUID?) {
        _selectedLayerId.value = id
    }

    fun updateLayer(layerId: java.util.UUID, updatedLayer: OCRLayer) {
        val currentState = _ocrState.value
        if (currentState is OCRState.Success) {
            val newLayers = currentState.layers.map { if (it.id == layerId) updatedLayer else it }
            
            undoStack.add(newLayers)
            redoStack.clear()
            updateUndoRedoStates()
            
            _ocrState.value = currentState.copy(layers = newLayers)
        }
    }

    fun undo() {
        if (undoStack.size > 1) {
            redoStack.add(undoStack.removeLast())
            val prevLayers = undoStack.last()
            
            val currentState = _ocrState.value
            if (currentState is OCRState.Success) {
                _ocrState.value = currentState.copy(layers = prevLayers)
            }
            updateUndoRedoStates()
        }
    }

    fun redo() {
        if (redoStack.isNotEmpty()) {
            val nextLayers = redoStack.removeLast()
            undoStack.add(nextLayers)
            
            val currentState = _ocrState.value
            if (currentState is OCRState.Success) {
                _ocrState.value = currentState.copy(layers = nextLayers)
            }
            updateUndoRedoStates()
        }
    }

    private fun updateUndoRedoStates() {
        _canUndo.value = undoStack.size > 1
        _canRedo.value = redoStack.isNotEmpty()
    }

    private fun parseToLayers(jsonString: String): List<OCRLayer> {
        val layers = mutableListOf<OCRLayer>()
        try {
            val root = JSONObject(jsonString)
            val blocksArray = root.optJSONArray("text_blocks") ?: root.optJSONArray("blocks") ?: return layers
            for (i in 0 until blocksArray.length()) {
                val blockObj = blocksArray.getJSONObject(i)
                val lines = blockObj.optJSONArray("lines")
                if (lines != null) for (j in 0 until lines.length()) {
                    val line = lines.getJSONObject(j)
                    parseCoreBox(line.optJSONObject("bounding_box"))?.let { box ->
                        val text = line.optString("text")
                        if (text.isNotBlank()) layers.add(OCRLayer(originalText = text, currentText = text, boundingBox = box,
                            fontSize = (box.height * 0.8f).coerceAtLeast(12f), fontFamily = "Noto Sans CJK"))
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return layers
    }

    private fun parseCoreBox(box: JSONObject?): BoundingBox? {
        box ?: return null
        val tl = box.optJSONArray("top_left") ?: return null
        val br = box.optJSONArray("bottom_right") ?: return null
        val x = tl.optInt(0); val y = tl.optInt(1)
        return BoundingBox(x, y, (br.optInt(0) - x).coerceAtLeast(1), (br.optInt(1) - y).coerceAtLeast(1))
    }

    private fun layersToJson(layers: List<OCRLayer>, width: Int, height: Int): String {
        val root = JSONObject().put("dimensions", JSONObject().put("width", width).put("height", height))
        val blocks = org.json.JSONArray()
        layers.filterNot { it.isRemoved }.forEach { layer ->
            val b = layer.boundingBox
            val box = JSONObject()
                .put("top_left", org.json.JSONArray(listOf(b.x, b.y)))
                .put("top_right", org.json.JSONArray(listOf(b.x + b.width, b.y)))
                .put("bottom_right", org.json.JSONArray(listOf(b.x + b.width, b.y + b.height)))
                .put("bottom_left", org.json.JSONArray(listOf(b.x, b.y + b.height)))
            blocks.put(JSONObject().put("lines", org.json.JSONArray().put(JSONObject().put("text", layer.currentText).put("bounding_box", box))))
        }
        return root.put("text_blocks", blocks).toString()
    }

    fun applyDefaultFontToAllRegions() {
        val currentState = _ocrState.value
        if (currentState is OCRState.Success) {
            val updatedLayers = currentState.layers.map { layer ->
                val isEnglishOrNumber = layer.currentText.matches(Regex("^[a-zA-Z0-9\\s\\p{Punct}]+$"))
                val fontName = if (isEnglishOrNumber) secondaryOCRFont.value else primaryOCRFont.value
                layer.copy(fontFamily = fontName)
            }
            
            undoStack.add(updatedLayers)
            redoStack.clear()
            updateUndoRedoStates()
            
            _ocrState.value = currentState.copy(layers = updatedLayers)
        }
    }
    
    private fun parseOCRResult(jsonString: String): List<TextBlock> {
        val blocks = mutableListOf<TextBlock>()
        try {
            val root = JSONObject(jsonString)
            if (!root.has("blocks")) return blocks
            val blocksArray = root.getJSONArray("blocks")
            for (i in 0 until blocksArray.length()) {
                val blockObj = blocksArray.getJSONObject(i)
                val linesArray = blockObj.getJSONArray("lines")
                val lines = mutableListOf<TextLine>()
                for (j in 0 until linesArray.length()) {
                    val lineObj = linesArray.getJSONObject(j)
                    val boxObj = lineObj.getJSONObject("boundingBox")
                    val boundingBox = BoundingBox(
                        x = boxObj.getInt("x"),
                        y = boxObj.getInt("y"),
                        width = boxObj.getInt("width"),
                        height = boxObj.getInt("height")
                    )
                    lines.add(
                        TextLine(
                            text = lineObj.getString("text"),
                            boundingBox = boundingBox,
                            confidence = lineObj.optDouble("confidence", 1.0)
                        )
                    )
                }
                
                val blockBoxObj = blockObj.getJSONObject("boundingBox")
                val blockBox = BoundingBox(
                    x = blockBoxObj.getInt("x"),
                    y = blockBoxObj.getInt("y"),
                    width = blockBoxObj.getInt("width"),
                    height = blockBoxObj.getInt("height")
                )
                blocks.add(TextBlock(lines, blockBox))
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return blocks
    }

    private fun preprocessBitmap(original: Bitmap): Bitmap {
        val bmp = Bitmap.createBitmap(original.width, original.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paint = Paint()
        
        // High contrast + grayscale
        val cm = ColorMatrix()
        cm.setSaturation(0f)
        val contrast = 1.5f
        val brightness = 0f
        val scale = contrast
        val translate = (-.5f * scale + .5f + brightness) * 255f
        val contrastMatrix = floatArrayOf(
            scale, 0f, 0f, 0f, translate,
            0f, scale, 0f, 0f, translate,
            0f, 0f, scale, 0f, translate,
            0f, 0f, 0f, 1f, 0f
        )
        cm.postConcat(ColorMatrix(contrastMatrix))
        
        paint.colorFilter = ColorMatrixColorFilter(cm)
        canvas.drawBitmap(original, 0f, 0f, paint)
        return bmp
    }
}
