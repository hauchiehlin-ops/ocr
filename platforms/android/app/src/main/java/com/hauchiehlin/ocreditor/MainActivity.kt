package com.hauchiehlin.ocreditor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import android.graphics.Typeface
import android.graphics.Paint
import androidx.compose.ui.unit.dp
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import android.app.Activity
import androidx.activity.result.IntentSenderRequest
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions.RESULT_FORMAT_JPEG
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions.SCANNER_MODE_FULL
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult

class MainActivity : ComponentActivity() {

    private val viewModel: OCRViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Simulate extracting lightweight models from assets to filesDir
        val lightweightModelPath = File(filesDir, "models_lightweight").absolutePath
        File(lightweightModelPath).mkdirs()
        // Simulate extracting dummy file so it exists
        File(lightweightModelPath, "ppocr_det_v5.onnx").writeText("dummy")

        // Downloaded models path
        val downloadedModelPath = File(filesDir, "models_pro").absolutePath
        File(downloadedModelPath).mkdirs()

        viewModel.initializeEngine(lightweightModelPath, downloadedModelPath)
        
        // Initialize Settings & Sync
        val settingsPath = File(filesDir, "settings.json").absolutePath
        OCREngineBridge.initSettings(settingsPath)
        // Auto Backup is enabled in AndroidManifest.xml (`android:allowBackup="true"`)
        // The settings.json file in filesDir will be automatically backed up and restored.

        // Initialize History DB
        val historyPath = File(filesDir, "history.db").absolutePath
        OCREngineBridge.initHistory(historyPath)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    MainScreen(viewModel)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(viewModel: OCRViewModel) {
    var selectedBitmap by remember { mutableStateOf<Bitmap?>(null) }
    val ocrState by viewModel.ocrState.collectAsState()
    val context = LocalContext.current
    var showBottomSheet by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            val inputStream: InputStream? = context.contentResolver.openInputStream(it)
            val bitmap = BitmapFactory.decodeStream(inputStream)
            val argbBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, true)
            selectedBitmap = argbBitmap
        }
    }

    val scannerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartIntentSenderForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val scanResult = GmsDocumentScanningResult.fromActivityResultIntent(result.data)
            scanResult?.pages?.let { pages ->
                // For batch processing, we can process all pages.
                // For simplicity here, we take the last scanned page and run OCR.
                val lastPage = pages.lastOrNull()
                lastPage?.imageUri?.let { uri ->
                    val inputStream: InputStream? = context.contentResolver.openInputStream(uri)
                    val bitmap = BitmapFactory.decodeStream(inputStream)
                    val argbBitmap = bitmap.copy(Bitmap.Config.ARGB_8888, true)
                    selectedBitmap = argbBitmap
                    viewModel.recognizeText(argbBitmap) // Auto recognize
                }
            }
        }
    }

    val startScanner = {
        val options = GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setResultFormats(RESULT_FORMAT_JPEG)
            .setScannerMode(SCANNER_MODE_FULL)
            .build()
        val scanner = GmsDocumentScanning.getClient(options)
        scanner.getStartScanIntent(context as Activity)
            .addOnSuccessListener { intentSender ->
                scannerLauncher.launch(IntentSenderRequest.Builder(intentSender).build())
            }
            .addOnFailureListener { e ->
                e.printStackTrace()
            }
    }

    val isUsingLightweightModel by viewModel.isUsingLightweightModel.collectAsState()

    Scaffold(
        topBar = { TopAppBar(isUsingLightweightModel = isUsingLightweightModel, onUpgrade = { viewModel.downloadModels() }, viewModel = viewModel) },
        bottomBar = {
            BottomBar(
                onSelectImage = { launcher.launch("image/*") },
                onScan = { startScanner() },
                onRecognize = { selectedBitmap?.let { viewModel.recognizeText(it) } },
                onInspect = { showBottomSheet = true },
                isEnabled = selectedBitmap != null && ocrState !is OCRState.Loading,
                hasResult = ocrState is OCRState.Success
            )
        }
    ) { paddingValues ->
        Box(modifier = Modifier.padding(paddingValues).fillMaxSize()) {
            selectedBitmap?.let { bitmap ->
                ImageViewer(bitmap, viewModel, 
                    onRegionSelected = { rect ->
                        viewModel.recognizeRegion(bitmap, rect.left.toInt(), rect.top.toInt(), rect.width.toInt(), rect.height.toInt())
                    }
                )
            } ?: run {
                Text(
                    text = "Please select an image",
                    modifier = Modifier.align(Alignment.Center)
                )
            }
            
            if (ocrState is OCRState.Loading) {
                CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
            }
            
            val selectedId by viewModel.selectedLayerId.collectAsState()
            val currentOcrState = ocrState
            if (selectedId != null && currentOcrState is OCRState.Success) {
                val state = currentOcrState
                val id = selectedId ?: return@Box
                val selectedLayer = state.layers.find { it.id == id }
                if (selectedLayer != null) {
                    LayerEditPanel(
                        layer = selectedLayer,
                        onUpdate = { viewModel.updateLayer(id, it) },
                        onClose = { viewModel.selectLayer(null) },
                        onAction = { action ->
                            when (action) {
                                "FIX" -> viewModel.fixTextWithLLM(id, selectedLayer.currentText)
                                "EXTRACT" -> viewModel.extractEntitiesWithLLM(id, selectedLayer.currentText)
                                "TRANSLATE" -> viewModel.translateWithLLM(id, selectedLayer.currentText)
                            }
                        },
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp)
                    )
                }
            }
        }
    }

    val showPrompt by viewModel.showModelDownloadPrompt.collectAsState()
    val isDownloading by viewModel.isDownloadingModels.collectAsState()
    val progress by viewModel.downloadProgress.collectAsState()

    // Removed startup prompt as we now fallback to lightweight model

    if (isDownloading) {
        AlertDialog(
            onDismissRequest = {},
            title = { Text("正在下載 AI 模型...") },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    LinearProgressIndicator(progress = progress.toFloat(), modifier = Modifier.fillMaxWidth())
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("${(progress * 100).toInt()}%")
                }
            },
            confirmButton = {}
        )
    }

    if (showBottomSheet && ocrState is OCRState.Success) {
        val successState = ocrState as OCRState.Success
        ModalBottomSheet(
            onDismissRequest = { showBottomSheet = false },
            sheetState = sheetState
        ) {
            InspectorContent(layers = successState.layers, viewModel = viewModel, selectedBitmap = selectedBitmap)
        }
    }
}

@Composable
fun InspectorContent(layers: List<OCRLayer>, viewModel: OCRViewModel, selectedBitmap: Bitmap?) {
    val context = LocalContext.current
    val fullText = layers.joinToString("\n") { it.currentText }
    
    val exportCsvLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/csv")
    ) { uri ->
        uri?.let {
            val csvData = viewModel.exportToCSV() ?: ""
            context.contentResolver.openOutputStream(it)?.use { out ->
                out.write(csvData.toByteArray(Charsets.UTF_8))
            }
        }
    }
    
    val exportPdfLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/pdf")
    ) { uri ->
        uri?.let {
            selectedBitmap?.let { bitmap ->
                viewModel.exportToPDF(context, it, bitmap)
            }
        }
    }
    
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp)
            .padding(bottom = 32.dp)
    ) {
        Text(
            text = "Inspector",
            style = MaterialTheme.typography.headlineSmall,
            modifier = Modifier.padding(bottom = 16.dp)
        )
        Text(
            text = "Total Layers: ${layers.size}",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(bottom = 8.dp)
        )
        Button(
            onClick = {
                val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                val clip = android.content.ClipData.newPlainText("OCR Result", fullText)
                clipboard.setPrimaryClip(clip)
            },
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)
        ) {
            Text("Copy All Text to Clipboard")
        }
        Button(
            onClick = { exportCsvLauncher.launch("export.csv") },
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)
        ) {
            Text("Export to CSV")
        }
        Button(
            onClick = { 
                if (selectedBitmap != null) {
                    exportPdfLauncher.launch("export_searchable.pdf") 
                } else {
                    android.widget.Toast.makeText(context, "No image to export.", android.widget.Toast.LENGTH_SHORT).show()
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Export to Searchable PDF")
        }
    }
}

@Composable
fun TopAppBar(isUsingLightweightModel: Boolean, onUpgrade: () -> Unit, viewModel: OCRViewModel) {
    val canUndo by viewModel.canUndo.collectAsState()
    val canRedo by viewModel.canRedo.collectAsState()
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth().height(56.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "OCR Editor",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            
            Row {
                TextButton(onClick = { viewModel.undo() }, enabled = canUndo) { Text("Undo") }
                TextButton(onClick = { viewModel.redo() }, enabled = canRedo) { Text("Redo") }
                if (isUsingLightweightModel) {
                    TextButton(onClick = onUpgrade) {
                        Text("Upgrade Model")
                    }
                }
            }
        }
    }
}

@Composable
fun ImageViewer(bitmap: Bitmap, viewModel: OCRViewModel, onRegionSelected: (androidx.compose.ui.geometry.Rect) -> Unit) {
    val ocrState by viewModel.ocrState.collectAsState()
    val selectedLayerId by viewModel.selectedLayerId.collectAsState()
    var scale by remember { mutableStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    
    var isSelectingRegion by remember { mutableStateOf(false) }
    var selectionStart by remember { mutableStateOf<Offset?>(null) }
    var selectionCurrent by remember { mutableStateOf<Offset?>(null) }
    
    val context = LocalContext.current

    val pointerModifier = if (isSelectingRegion) {
        Modifier.pointerInput(Unit) {
            detectDragGestures(
                onDragStart = { dragStart ->
                    selectionStart = dragStart
                    selectionCurrent = dragStart
                },
                onDrag = { change, dragAmount ->
                    selectionCurrent = selectionCurrent?.plus(dragAmount)
                },
                onDragEnd = {
                    val start = selectionStart
                    val end = selectionCurrent
                    if (start != null && end != null) {
                        // For mapping to original image coordinates
                        // Assuming simple content scale fit matching
                        val imgRatio = bitmap.width.toFloat() / bitmap.height.toFloat()
                        val canvasRatio = size.width.toFloat() / size.height.toFloat()
                        
                        var drawWidth = size.width.toFloat()
                        var drawHeight = size.height.toFloat()
                        var startX = 0f
                        var startY = 0f
                        
                        if (imgRatio > canvasRatio) {
                            drawHeight = size.width.toFloat() / imgRatio
                            startY = (size.height.toFloat() - drawHeight) / 2f
                        } else {
                            drawWidth = size.height.toFloat() * imgRatio
                            startX = (size.width.toFloat() - drawWidth) / 2f
                        }

                        val scaleX = bitmap.width / drawWidth
                        val scaleY = bitmap.height / drawHeight
                        
                        val rectX = ((kotlin.math.min(start.x, end.x) - offset.x) / scale - startX) * scaleX
                        val rectY = ((kotlin.math.min(start.y, end.y) - offset.y) / scale - startY) * scaleY
                        val rectW = (kotlin.math.abs(start.x - end.x) / scale) * scaleX
                        val rectH = (kotlin.math.abs(start.y - end.y) / scale) * scaleY

                        onRegionSelected(androidx.compose.ui.geometry.Rect(rectX, rectY, rectX + rectW, rectY + rectH))
                    }
                    selectionStart = null
                    selectionCurrent = null
                    isSelectingRegion = false
                }
            )
        }
    } else {
        Modifier
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(0.5f, 5f)
                    offset += pan
                }
            }
            .pointerInput("tap") {
                detectTapGestures(
                    onTap = { tapOffset ->
                        val currentState = ocrState
                        if (currentState is OCRState.Success) {
                            val imgRatio = bitmap.width.toFloat() / bitmap.height.toFloat()
                            val canvasRatio = size.width.toFloat() / size.height.toFloat()
                            var drawWidth = size.width.toFloat()
                            var drawHeight = size.height.toFloat()
                            var startXVal = 0f
                            var startYVal = 0f
                            if (imgRatio > canvasRatio) {
                                drawHeight = size.width.toFloat() / imgRatio
                                startYVal = (size.height.toFloat() - drawHeight) / 2f
                            } else {
                                drawWidth = size.height.toFloat() * imgRatio
                                startXVal = (size.width.toFloat() - drawWidth) / 2f
                            }
                            val scaleX = drawWidth / bitmap.width
                            val scaleY = drawHeight / bitmap.height
                            val mappedX = ((tapOffset.x - offset.x) / scale - startXVal) / scaleX
                            val mappedY = ((tapOffset.y - offset.y) / scale - startYVal) / scaleY
                            var found = false
                            for (layer in currentState.layers) {
                                if (!layer.isRemoved &&
                                    mappedX >= layer.boundingBox.x && mappedX <= (layer.boundingBox.x + layer.boundingBox.width) &&
                                    mappedY >= layer.boundingBox.y && mappedY <= (layer.boundingBox.y + layer.boundingBox.height)) {
                                    viewModel.selectLayer(layer.id)
                                    found = true
                                    break
                                }
                            }
                            if (!found) viewModel.selectLayer(null)
                        }
                    }
                )
            }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .then(pointerModifier)
    ) {
        Box(modifier = Modifier
            .fillMaxSize()
            .graphicsLayer(
                scaleX = scale,
                scaleY = scale,
                translationX = offset.x,
                translationY = offset.y
            )
        ) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = "Selected Image",
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize()
            )
            
            if (ocrState is OCRState.Success) {
                Canvas(modifier = Modifier.fillMaxSize()) {
                // Simplified drawing logic; needs proper scaling/mapping from bitmap to canvas size
                // For now just drawing relative boxes assuming the image fills the canvas width
                val imgRatio = bitmap.width.toFloat() / bitmap.height.toFloat()
                val canvasRatio = size.width / size.height
                
                var drawWidth = size.width
                var drawHeight = size.height
                var startX = 0f
                var startY = 0f
                
                if (imgRatio > canvasRatio) {
                    drawHeight = size.width / imgRatio
                    startY = (size.height - drawHeight) / 2f
                } else {
                    drawWidth = size.height * imgRatio
                    startX = (size.width - drawWidth) / 2f
                }

                val scaleX = drawWidth / bitmap.width
                val scaleY = drawHeight / bitmap.height

                val notoSans = Typeface.createFromAsset(context.assets, "fonts/NotoSansTC-Regular.otf")
                val notoSerif = Typeface.createFromAsset(context.assets, "fonts/NotoSerifTC-Regular.otf")

                val successState = ocrState as? OCRState.Success ?: return@Canvas
                for (layer in successState.layers) {
                    if (layer.isRemoved) continue
                    
                    val rectX = startX + layer.boundingBox.x * scaleX
                    val rectY = startY + layer.boundingBox.y * scaleY
                    val rectW = layer.boundingBox.width * scaleX
                    val rectH = layer.boundingBox.height * scaleY

                    val isSelected = layer.id == selectedLayerId
                    val boxColor = if (isSelected) Color.Blue else Color.Green.copy(alpha = 0.5f)
                    
                    drawRect(
                        color = boxColor,
                        topLeft = Offset(rectX, rectY),
                        size = Size(rectW, rectH),
                        style = Stroke(width = if (isSelected) 8f else 4f)
                    )
                    
                    val textPaint = Paint().apply {
                        color = layer.fontColor
                        textSize = layer.fontSize * scaleY
                        typeface = if (layer.isBold) Typeface.create(notoSans, Typeface.BOLD) else notoSans
                    }
                    
                    drawContext.canvas.nativeCanvas.drawText(
                        layer.currentText,
                        rectX,
                        rectY + rectH * 0.8f,
                        textPaint
                    )
                }
            }
            }
        }
        
        if (isSelectingRegion) {
            Button(
                onClick = { isSelectingRegion = false },
                modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)
            ) {
                Text("Cancel Regional OCR")
            }
        } else {
            Button(
                onClick = { isSelectingRegion = true },
                modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)
            ) {
                Text("Regional OCR")
            }
        }
        
        // Draw selection rect on top
        if (isSelectingRegion && selectionStart != null && selectionCurrent != null) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val start = selectionStart!!
                val current = selectionCurrent!!
                drawRect(
                    color = Color.Blue.copy(alpha = 0.3f),
                    topLeft = Offset(kotlin.math.min(start.x, current.x), kotlin.math.min(start.y, current.y)),
                    size = Size(kotlin.math.abs(start.x - current.x), kotlin.math.abs(start.y - current.y))
                )
                drawRect(
                    color = Color.Blue,
                    topLeft = Offset(kotlin.math.min(start.x, current.x), kotlin.math.min(start.y, current.y)),
                    size = Size(kotlin.math.abs(start.x - current.x), kotlin.math.abs(start.y - current.y)),
                    style = Stroke(width = 4f)
                )
            }
        }
    }
}

@Composable
fun BottomBar(
    onSelectImage: () -> Unit,
    onScan: () -> Unit,
    onRecognize: () -> Unit,
    onInspect: () -> Unit,
    isEnabled: Boolean,
    hasResult: Boolean
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth().height(72.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxSize(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Button(onClick = onSelectImage) {
                Text("Select")
            }
            Button(onClick = onScan) {
                Text("Scan")
            }
            Button(onClick = onRecognize, enabled = isEnabled) {
                Text("Recognize")
            }
            if (hasResult) {
                Button(onClick = onInspect) {
                    Text("Inspector")
                }
            }
        }
    }
}

@Composable
fun LayerEditPanel(layer: OCRLayer, onUpdate: (OCRLayer) -> Unit, onClose: () -> Unit, onAction: (String) -> Unit = {}, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(0.9f),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = MaterialTheme.shapes.medium,
        tonalElevation = 8.dp
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Text("Edit Layer", style = MaterialTheme.typography.titleMedium)
                Text(text = "✕", modifier = Modifier.clickable { onClose() })
            }
            Spacer(modifier = Modifier.height(8.dp))
            OutlinedTextField(
                value = layer.currentText,
                onValueChange = { onUpdate(layer.copy(currentText = it)) },
                label = { Text("Text Content") },
                modifier = Modifier.fillMaxWidth()
            )
            Spacer(modifier = Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Size:")
                Slider(
                    value = layer.fontSize,
                    onValueChange = { onUpdate(layer.copy(fontSize = it)) },
                    valueRange = 8f..120f,
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp)
                )
                Text("${layer.fontSize.toInt()}")
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { onUpdate(layer.copy(isBold = !layer.isBold)) }) {
                    Text("Bold", color = if (layer.isBold) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
                TextButton(onClick = { onUpdate(layer.copy(isItalic = !layer.isItalic)) }) {
                    Text("Italic", color = if (layer.isItalic) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                val colors = listOf(android.graphics.Color.BLACK, android.graphics.Color.WHITE, android.graphics.Color.RED, android.graphics.Color.BLUE, android.graphics.Color.GREEN)
                colors.forEach { col ->
                    Box(modifier = Modifier
                        .size(32.dp)
                        .background(Color(col), shape = androidx.compose.foundation.shape.CircleShape)
                        .border(1.dp, Color.Gray, androidx.compose.foundation.shape.CircleShape)
                        .clickable { onUpdate(layer.copy(fontColor = col)) }
                    )
                }
            }
            Button(
                onClick = { onUpdate(layer.copy(isRemoved = true)); onClose() },
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
            ) {
                Text("Remove Text (Inpaint)")
            }

            Spacer(modifier = Modifier.height(8.dp))
            Text("AI Operations", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Spacer(modifier = Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(onClick = { onAction("FIX") }, modifier = Modifier.weight(1f)) {
                    Text("Fix Text")
                }
                Button(onClick = { onAction("EXTRACT") }, modifier = Modifier.weight(1f)) {
                    Text("Extract")
                }
                Button(onClick = { onAction("TRANSLATE") }, modifier = Modifier.weight(1f)) {
                    Text("Translate")
                }
            }
        }
    }
}
