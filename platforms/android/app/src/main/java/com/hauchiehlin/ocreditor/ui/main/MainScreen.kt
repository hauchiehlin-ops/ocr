package com.hauchiehlin.ocreditor.ui.main

import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
// Icons replaced with Text
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import com.hauchiehlin.ocreditor.OCRLayer
import com.hauchiehlin.ocreditor.OCRState
import com.hauchiehlin.ocreditor.OCRViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    onItemClick: (NavKey) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: OCRViewModel = viewModel()
) {
    val ocrState by viewModel.ocrState.collectAsStateWithLifecycle()
    val canUndo by viewModel.canUndo.collectAsStateWithLifecycle()
    val canRedo by viewModel.canRedo.collectAsStateWithLifecycle()
    val selectedLayerId by viewModel.selectedLayerId.collectAsStateWithLifecycle()
    
    var currentBitmap by remember { mutableStateOf<Bitmap?>(null) }
    val context = LocalContext.current
    
    val imagePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            val source = android.graphics.ImageDecoder.createSource(context.contentResolver, it)
            val bitmap = android.graphics.ImageDecoder.decodeBitmap(source) { decoder, _, _ ->
                decoder.allocator = android.graphics.ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.isMutableRequired = true
            }
            currentBitmap = bitmap
            viewModel.recognizeText(bitmap)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("OCR Editor") },
                actions = {
                    TextButton(onClick = { imagePicker.launch("image/*") }) {
                        Text("Add")
                    }
                    if (ocrState is OCRState.Success) {
                        TextButton(onClick = { viewModel.closeImage() }) {
                            Text("Close")
                        }
                    }
                    TextButton(onClick = { viewModel.undo() }, enabled = canUndo) {
                        Text("Undo")
                    }
                    TextButton(onClick = { viewModel.redo() }, enabled = canRedo) {
                        Text("Redo")
                    }
                    var fontMenuExpanded by remember { mutableStateOf(false) }
                    val forceFont by viewModel.forceComputerFontAfterOCR.collectAsStateWithLifecycle()
                    Box {
                        TextButton(onClick = { fontMenuExpanded = true }) {
                            Text("Fonts")
                        }
                        DropdownMenu(expanded = fontMenuExpanded, onDismissRequest = { fontMenuExpanded = false }) {
                            DropdownMenuItem(
                                text = { Text(if (forceFont) "Disable Force Font" else "Enable Force Font") },
                                onClick = { 
                                    viewModel.forceComputerFontAfterOCR.value = !forceFont
                                    fontMenuExpanded = false
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("Apply Fonts to All") },
                                onClick = { 
                                    viewModel.applyDefaultFontToAllRegions()
                                    fontMenuExpanded = false
                                }
                            )
                        }
                    }

                    var expanded by remember { mutableStateOf(false) }
                    Box {
                        TextButton(onClick = { expanded = true }) {
                            Text("Export")
                        }
                        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                            DropdownMenuItem(
                                text = { Text("Export Markdown") },
                                onClick = { 
                                    expanded = false
                                    // Implementation
                                }
                            )
                        }
                    }
                }
            )
        }
    ) { paddingValues ->
        Box(modifier = modifier.padding(paddingValues).fillMaxSize()) {
            // 畫布區
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.DarkGray)
            ) {
                if (currentBitmap != null) {
                    CanvasArea(
                        bitmap = currentBitmap!!,
                        ocrState = ocrState,
                        selectedLayerId = selectedLayerId,
                        onLayerSelected = { viewModel.selectLayer(it) },
                        onLayerUpdate = { id, layer -> viewModel.updateLayer(id, layer) }
                    )
                } else {
                    Text(
                        "Please load an image",
                        color = Color.White,
                        modifier = Modifier.align(Alignment.Center)
                    )
                }
                
                if (ocrState is OCRState.Loading) {
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
                }
            }
            
            // 底部屬性面板區 (ModalBottomSheet)
            if (selectedLayerId != null && ocrState is OCRState.Success) {
                val state = ocrState as OCRState.Success
                val selectedLayer = state.layers.find { it.id == selectedLayerId }
                if (selectedLayer != null) {
                    ModalBottomSheet(
                        onDismissRequest = { viewModel.selectLayer(null) }
                    ) {
                        PropertyPanel(
                            layer = selectedLayer,
                            onUpdate = { viewModel.updateLayer(selectedLayer.id, it) },
                            onTranslate = { viewModel.translateWithLLM(selectedLayer.id, it) },
                            onFix = { viewModel.fixTextWithLLM(selectedLayer.id, it) }
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun CanvasArea(
    bitmap: Bitmap,
    ocrState: OCRState,
    selectedLayerId: java.util.UUID?,
    onLayerSelected: (java.util.UUID?) -> Unit,
    onLayerUpdate: (java.util.UUID, OCRLayer) -> Unit
) {
    var scale by remember { mutableStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }

    Canvas(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectTransformGestures { centroid, pan, zoom, rotation ->
                    scale = (scale * zoom).coerceIn(0.1f, 5f)
                    offset += pan
                }
            }
            .pointerInput(Unit) {
                detectTapGestures { tapOffset ->
                    if (ocrState is OCRState.Success) {
                        // 轉換觸控座標至畫布內座標
                        val scaledX = (tapOffset.x - offset.x) / scale
                        val scaledY = (tapOffset.y - offset.y) / scale
                        
                        val clickedLayer = ocrState.layers.find { layer ->
                            !layer.isRemoved &&
                            scaledX >= layer.boundingBox.x && scaledX <= (layer.boundingBox.x + layer.boundingBox.width) &&
                            scaledY >= layer.boundingBox.y && scaledY <= (layer.boundingBox.y + layer.boundingBox.height)
                        }
                        onLayerSelected(clickedLayer?.id)
                    }
                }
            }
    ) {
        translate(left = offset.x, top = offset.y) {
            scale(scale, pivot = Offset.Zero) {
                // 繪製原始圖片 (後續可以替換為 Inpaint 過的背景)
                drawImage(image = bitmap.asImageBitmap())

                // 繪製圖層與選取框
                if (ocrState is OCRState.Success) {
                    for (layer in ocrState.layers) {
                        if (layer.isRemoved) continue
                        
                        val rect = Rect(
                            left = layer.boundingBox.x.toFloat(),
                            top = layer.boundingBox.y.toFloat(),
                            right = (layer.boundingBox.x + layer.boundingBox.width).toFloat(),
                            bottom = (layer.boundingBox.y + layer.boundingBox.height).toFloat()
                        )
                        
                        if (layer.id == selectedLayerId) {
                            drawRect(
                                color = Color.Blue.copy(alpha = 0.3f),
                                topLeft = rect.topLeft,
                                size = rect.size
                            )
                            drawRect(
                                color = Color.Blue,
                                topLeft = rect.topLeft,
                                size = rect.size,
                                style = Stroke(width = 2f / scale)
                            )
                        } else {
                            drawRect(
                                color = Color.Gray.copy(alpha = 0.1f),
                                topLeft = rect.topLeft,
                                size = rect.size,
                                style = Stroke(width = 1f / scale)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun PropertyPanel(
    layer: OCRLayer,
    onUpdate: (OCRLayer) -> Unit,
    onTranslate: (String) -> Unit,
    onFix: (String) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp)
            .padding(bottom = 32.dp)
    ) {
        Text("Properties", style = MaterialTheme.typography.titleLarge)
        Spacer(modifier = Modifier.height(16.dp))
        
        OutlinedTextField(
            value = layer.currentText,
            onValueChange = { onUpdate(layer.copy(currentText = it, isEdited = true)) },
            label = { Text("Text Content") },
            modifier = Modifier.fillMaxWidth()
        )
        
        Spacer(modifier = Modifier.height(16.dp))
        
        Button(
            onClick = { onTranslate(layer.currentText) },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Translate (LLM)")
        }
        
        Spacer(modifier = Modifier.height(8.dp))
        
        Button(
            onClick = { onFix(layer.currentText) },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Fix Typo (LLM)")
        }
    }
}
