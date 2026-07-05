/**
 * @file OCRViewModel.kt
 * @brief Android ViewModel for the OCR Visual Editor screen.
 *
 * Manages:
 *   - UI state machine (idle → loading → scanning → complete / error)
 *   - Edit mode switching (view / select / edit / delete)
 *   - Word-level selection tracking
 *   - Asynchronous OCR scanning and text inpainting
 *   - Native engine lifecycle (released on ViewModel clear)
 *
 * Exposes reactive [StateFlow] properties that the UI layer collects to
 * drive Compose or View-based rendering.
 *
 * @copyright 2026 OCR Visual Editor Contributors
 * @license Apache-2.0
 */

package com.ocreditor.viewmodel

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ocreditor.bridge.BoundingBox
import com.ocreditor.bridge.OCREngine
import com.ocreditor.bridge.OCRResult
import com.ocreditor.bridge.TextWord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ---------------------------------------------------------------------------
// UI state hierarchy
// ---------------------------------------------------------------------------

/**
 * Sealed class representing the exhaustive set of UI states for the OCR
 * editor screen.
 *
 * Each subclass carries only the data relevant to its state, making it safe
 * and ergonomic to use in `when` expressions without an `else` branch.
 */
sealed class UiState {
    /** No image loaded; the editor is waiting for user input. */
    data object Idle : UiState()

    /** The engine or image is being prepared (e.g. model loading). */
    data object Loading : UiState()

    /**
     * OCR recognition is in progress.
     *
     * @property progress Estimated progress in `[0.0, 1.0]`.
     */
    data class Scanning(val progress: Float = 0f) : UiState()

    /** Text inpainting is in progress. */
    data object Inpainting : UiState()

    /**
     * Recognition (and optional editing) is complete.
     *
     * @property result The parsed OCR result.
     * @property image  The current bitmap (may be inpainted).
     */
    data class Complete(
        val result: OCRResult,
        val image: Bitmap,
    ) : UiState()

    /**
     * An unrecoverable error occurred.
     *
     * @property message A human-readable error description.
     */
    data class Error(val message: String) : UiState()
}

// ---------------------------------------------------------------------------
// Edit mode enum
// ---------------------------------------------------------------------------

/**
 * The current editing mode of the OCR Visual Editor.
 */
enum class EditMode {
    /** Read-only view – no interactions with text overlays. */
    VIEW,

    /** User can tap words to toggle selection. */
    SELECT,

    /** User can edit the text content of selected words. */
    EDIT,

    /** User can tap words to mark them for deletion (inpainting). */
    DELETE,
}

// ---------------------------------------------------------------------------
// ViewModel
// ---------------------------------------------------------------------------

/**
 * ViewModel for the OCR Visual Editor activity / fragment.
 *
 * Owns the [OCREngine] instance and exposes reactive [StateFlow]s for:
 * - [uiState]       – current UI state machine position
 * - [editMode]      – current editing mode
 * - [selectedWords] – set of currently selected [TextWord] instances
 *
 * All heavy work (recognition, inpainting) runs on [Dispatchers.Default]
 * via [viewModelScope].
 *
 * @param application The application context, forwarded to [OCREngine].
 */
class OCRViewModel(application: Application) : AndroidViewModel(application) {

    // -- State flows --------------------------------------------------------

    private val _uiState = MutableStateFlow<UiState>(UiState.Idle)
    /** Observable UI state. Collect in the UI layer to drive rendering. */
    val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    private val _editMode = MutableStateFlow(EditMode.VIEW)
    /** Observable edit mode. */
    val editMode: StateFlow<EditMode> = _editMode.asStateFlow()

    private val _selectedWords = MutableStateFlow<Set<TextWord>>(emptySet())
    /** The set of words currently selected by the user. */
    val selectedWords: StateFlow<Set<TextWord>> = _selectedWords.asStateFlow()

    // -- Engine instance (lazy) ---------------------------------------------

    /** Lazily initialised OCR engine – created on first scan request. */
    private var engine: OCREngine? = null

    /**
     * The most recent successfully processed bitmap, kept for inpainting
     * operations that need the "current" image.
     */
    private var currentBitmap: Bitmap? = null

    /**
     * The most recent OCR result, cached so that selection / mode changes
     * do not require a re-scan.
     */
    private var currentResult: OCRResult? = null

    // -- Public API ---------------------------------------------------------

    /**
     * Start an OCR scan for the image identified by a content [Uri].
     *
     * Loads the bitmap from the content resolver, then delegates to
     * [scanBitmap].
     *
     * @param uri A `content://` or `file://` URI pointing to the image.
     */
    fun scanImage(uri: Uri) {
        viewModelScope.launch {
            _uiState.value = UiState.Loading

            val bitmap = withContext(Dispatchers.IO) {
                try {
                    getApplication<Application>()
                        .contentResolver
                        .openInputStream(uri)
                        ?.use { BitmapFactory.decodeStream(it) }
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to load image from URI: $uri", e)
                    null
                }
            }

            if (bitmap == null) {
                _uiState.value = UiState.Error("Failed to load image")
                return@launch
            }

            scanBitmap(bitmap)
        }
    }

    /**
     * Start an OCR scan on an already-decoded [Bitmap].
     *
     * @param bitmap The source image in ARGB_8888 format.
     */
    fun scanBitmap(bitmap: Bitmap) {
        viewModelScope.launch {
            _uiState.value = UiState.Scanning(progress = 0f)
            clearSelection()

            try {
                _uiState.value = UiState.Scanning(progress = 0.1f)

                val result = performOCR(bitmap)

                if (result != null) {
                    currentBitmap = bitmap
                    currentResult = result
                    _uiState.value = UiState.Complete(result = result, image = bitmap)
                    Log.i(TAG, "Scan complete: ${result.wordCount} words detected")
                } else {
                    _uiState.value = UiState.Error("OCR recognition returned no results")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Scan failed", e)
                _uiState.value = UiState.Error(e.message ?: "Unknown error during OCR scan")
            }
        }
    }

    /**
     * Change the current editing mode.
     *
     * Automatically clears the word selection when switching away from
     * [EditMode.SELECT] or [EditMode.DELETE].
     *
     * @param mode The new [EditMode].
     */
    fun setEditMode(mode: EditMode) {
        if (_editMode.value != mode) {
            // Clear selection when leaving selection-oriented modes.
            if (_editMode.value == EditMode.SELECT || _editMode.value == EditMode.DELETE) {
                clearSelection()
            }
            _editMode.value = mode
            Log.d(TAG, "Edit mode changed to $mode")
        }
    }

    /**
     * Toggle selection state for a single word.
     *
     * If the word is already selected it is deselected, and vice versa.
     *
     * @param word The [TextWord] to toggle.
     */
    fun toggleWordSelection(word: TextWord) {
        _selectedWords.value = _selectedWords.value.let { current ->
            if (word in current) current - word else current + word
        }
    }

    /**
     * Select all words in the current OCR result.
     */
    fun selectAll() {
        val result = currentResult ?: return
        val allWords = result.blocks.flatMap { block ->
            block.lines.flatMap { line -> line.words }
        }.toSet()
        _selectedWords.value = allWords
        Log.d(TAG, "Selected all ${allWords.size} words")
    }

    /**
     * Clear the current word selection.
     */
    fun clearSelection() {
        _selectedWords.value = emptySet()
    }

    /**
     * Delete (inpaint) the currently selected text regions from the image.
     *
     * Collects the bounding boxes of all selected words, sends them to the
     * native engine for inpainting, and updates the UI state with the result.
     *
     * After successful inpainting the selection is cleared and a new OCR
     * scan is triggered on the modified image to refresh overlays.
     */
    fun deleteSelectedText() {
        val selected = _selectedWords.value
        if (selected.isEmpty()) {
            Log.w(TAG, "deleteSelectedText called with no selection")
            return
        }

        val bitmap = currentBitmap ?: run {
            _uiState.value = UiState.Error("No image loaded for inpainting")
            return
        }

        viewModelScope.launch {
            _uiState.value = UiState.Inpainting

            try {
                val boxes: List<BoundingBox> = selected.map { it.boundingBox }

                val resultBitmap = withContext(Dispatchers.Default) {
                    ensureEngine().removeText(bitmap, boxes)
                }

                if (resultBitmap != null) {
                    clearSelection()
                    Log.i(TAG, "Inpainting complete – re-scanning modified image")
                    // Re-scan the inpainted image to refresh OCR overlays.
                    scanBitmap(resultBitmap)
                } else {
                    _uiState.value = UiState.Error("Text removal returned no result")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Inpainting failed", e)
                _uiState.value = UiState.Error(e.message ?: "Unknown error during inpainting")
            }
        }
    }

    // -- Internal -----------------------------------------------------------

    /**
     * Execute OCR recognition on [bitmap] using the native engine.
     *
     * Runs on [Dispatchers.Default] to keep the main thread free.
     *
     * @return The parsed [OCRResult], or `null` on failure.
     */
    private suspend fun performOCR(bitmap: Bitmap): OCRResult? {
        return withContext(Dispatchers.Default) {
            _uiState.value = UiState.Scanning(progress = 0.3f)
            val eng = ensureEngine()

            _uiState.value = UiState.Scanning(progress = 0.5f)
            val result = eng.recognize(bitmap)

            _uiState.value = UiState.Scanning(progress = 1.0f)
            result
        }
    }

    /**
     * Return the existing [OCREngine] or create one.
     *
     * Engine creation is idempotent; calling this multiple times after
     * initialisation returns the same instance.
     */
    private fun ensureEngine(): OCREngine {
        return engine ?: OCREngine(getApplication<Application>().applicationContext).also {
            engine = it
        }
    }

    // -- Lifecycle ----------------------------------------------------------

    override fun onCleared() {
        super.onCleared()
        engine?.release()
        engine = null
        currentBitmap = null
        currentResult = null
        Log.i(TAG, "ViewModel cleared – engine released")
    }

    // -- Companion ----------------------------------------------------------

    companion object {
        private const val TAG = "OCRViewModel"
    }
}
