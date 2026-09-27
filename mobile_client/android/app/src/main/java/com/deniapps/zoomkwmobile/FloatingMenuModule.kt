package com.deniapps.zoomkwmobile

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlin.math.abs

class FloatingMenuModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var windowManager: WindowManager? = null
    private var floatingRoot: FrameLayout? = null
    private var collapsedView: LinearLayout? = null
    private var expandedView: LinearLayout? = null
    private var micButton: TextView? = null
    private var camButton: TextView? = null
    private var isExpanded = false
    private var layoutParams: WindowManager.LayoutParams? = null

    override fun getName(): String = "FloatingMenuModule"

    @ReactMethod
    fun canDrawOverlays(promise: Promise) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            promise.resolve(Settings.canDrawOverlays(reactContext))
        } else {
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun requestOverlayPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(reactContext)) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${reactContext.packageName}")
                )
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(intent)
            }
        }
    }

    @ReactMethod
    fun showFloatingMenu(params: ReadableMap?) {
        UiThreadUtil.runOnUiThread {
            if (floatingRoot != null) {
                updateUIState(params)
                return@runOnUiThread
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(reactContext)) {
                return@runOnUiThread
            }

            try {
                windowManager = reactContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                createFloatingView(params)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    @ReactMethod
    fun updateState(params: ReadableMap?) {
        UiThreadUtil.runOnUiThread {
            updateUIState(params)
        }
    }

    @ReactMethod
    fun hideFloatingMenu() {
        UiThreadUtil.runOnUiThread {
            if (floatingRoot != null && windowManager != null) {
                try {
                    windowManager?.removeView(floatingRoot)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
                floatingRoot = null
                collapsedView = null
                expandedView = null
                micButton = null
                camButton = null
                isExpanded = false
                layoutParams = null
            }
        }
    }

    private fun dpToPx(dp: Float): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            dp,
            reactContext.resources.displayMetrics
        ).toInt()
    }

    private fun createRoundedDrawable(colorHex: String, radiusDp: Float, strokeColorHex: String? = null): GradientDrawable {
        val drawable = GradientDrawable()
        drawable.shape = GradientDrawable.RECTANGLE
        drawable.cornerRadius = dpToPx(radiusDp).toFloat()
        drawable.setColor(Color.parseColor(colorHex))
        if (strokeColorHex != null) {
            drawable.setStroke(dpToPx(1.5f), Color.parseColor(strokeColorHex))
        }
        return drawable
    }

    private fun sendEvent(eventName: String) {
        if (reactContext.hasActiveReactInstance()) {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, null)
        }
    }

    private fun createFloatingView(params: ReadableMap?) {
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                WindowManager.LayoutParams.TYPE_PHONE
            },
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = dpToPx(16f)
        lp.y = dpToPx(120f)
        layoutParams = lp

        val root = FrameLayout(reactContext)
        floatingRoot = root

        // --- 1. COLLAPSED VIEW (Mini Bubble Pill) ---
        val collapsed = LinearLayout(reactContext).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dpToPx(12f), dpToPx(8f), dpToPx(12f), dpToPx(8f))
            background = createRoundedDrawable("#0f172a", 24f, "#38bdf8")
            elevation = dpToPx(6f).toFloat()

            val liveDot = View(reactContext).apply {
                layoutParams = LinearLayout.LayoutParams(dpToPx(8f), dpToPx(8f)).apply {
                    marginEnd = dpToPx(6f)
                }
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor("#22c55e"))
                }
            }
            addView(liveDot)

            val textBadge = TextView(reactContext).apply {
                text = "⚡ ZOOM KW"
                setTextColor(Color.parseColor("#ffffff"))
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
            }
            addView(textBadge)
        }
        collapsedView = collapsed
        root.addView(collapsed)

        // --- 2. EXPANDED VIEW (Control Strip) ---
        val expanded = LinearLayout(reactContext).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dpToPx(8f), dpToPx(6f), dpToPx(8f), dpToPx(6f))
            background = createRoundedDrawable("#1e293b", 16f, "#38bdf8")
            elevation = dpToPx(8f).toFloat()
            visibility = View.GONE

            // Live status badge
            val badgeLive = TextView(reactContext).apply {
                text = "🔴 LIVE"
                setTextColor(Color.parseColor("#4ade80"))
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                setPadding(dpToPx(6f), dpToPx(4f), dpToPx(6f), dpToPx(4f))
                background = createRoundedDrawable("#14532d", 6f)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    marginEnd = dpToPx(6f)
                }
            }
            addView(badgeLive)

            // Mic Button
            val btnMic = TextView(reactContext).apply {
                text = "🔇 Mic"
                setTextColor(Color.parseColor("#cbd5e1"))
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
                setPadding(dpToPx(8f), dpToPx(6f), dpToPx(8f), dpToPx(6f))
                background = createRoundedDrawable("#334155", 8f)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    marginEnd = dpToPx(6f)
                }
                setOnClickListener {
                    sendEvent("onFloatingToggleMic")
                }
            }
            micButton = btnMic
            addView(btnMic)

            // Camera Button
            val btnCam = TextView(reactContext).apply {
                text = "📷 Cam"
                setTextColor(Color.parseColor("#cbd5e1"))
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
                setPadding(dpToPx(8f), dpToPx(6f), dpToPx(8f), dpToPx(6f))
                background = createRoundedDrawable("#334155", 8f)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    marginEnd = dpToPx(6f)
                }
                setOnClickListener {
                    sendEvent("onFloatingToggleCamera")
                }
            }
            camButton = btnCam
            addView(btnCam)

            // Stop Button
            val btnStop = TextView(reactContext).apply {
                text = "⏹️ Stop"
                setTextColor(Color.parseColor("#ffffff"))
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
                setPadding(dpToPx(8f), dpToPx(6f), dpToPx(8f), dpToPx(6f))
                background = createRoundedDrawable("#dc2626", 8f)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    marginEnd = dpToPx(6f)
                }
                setOnClickListener {
                    sendEvent("onFloatingStopShare")
                }
            }
            addView(btnStop)

            // Minimize Button
            val btnClose = TextView(reactContext).apply {
                text = "✕"
                setTextColor(Color.parseColor("#94a3b8"))
                textSize = 14f
                typeface = Typeface.DEFAULT_BOLD
                setPadding(dpToPx(6f), dpToPx(4f), dpToPx(6f), dpToPx(4f))
                setOnClickListener {
                    toggleExpanded(false)
                }
            }
            addView(btnClose)
        }
        expandedView = expanded
        root.addView(expanded)

        // --- Drag & Drop Touch Handling ---
        var initialX = 0
        var initialY = 0
        var initialTouchX = 0f
        var initialTouchY = 0f
        var isMoving = false

        collapsed.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = lp.x
                    initialY = lp.y
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    isMoving = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - initialTouchX).toInt()
                    val dy = (event.rawY - initialTouchY).toInt()
                    if (abs(dx) > 10 || abs(dy) > 10) {
                        isMoving = true
                    }
                    if (isMoving) {
                        lp.x = initialX + dx
                        lp.y = initialY + dy
                        windowManager?.updateViewLayout(root, lp)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!isMoving) {
                        toggleExpanded(true)
                    }
                    true
                }
                else -> false
            }
        }

        // Expanded view drag
        expanded.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = lp.x
                    initialY = lp.y
                    initialTouchX = event.rawX
                    initialTouchY = event.rawY
                    isMoving = false
                    false // Allow child buttons to get click if not dragged
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - initialTouchX).toInt()
                    val dy = (event.rawY - initialTouchY).toInt()
                    if (abs(dx) > 12 || abs(dy) > 12) {
                        isMoving = true
                        lp.x = initialX + dx
                        lp.y = initialY + dy
                        windowManager?.updateViewLayout(root, lp)
                    }
                    true
                }
                else -> false
            }
        }

        updateUIState(params)
        windowManager?.addView(root, lp)
    }

    private fun toggleExpanded(expand: Boolean) {
        isExpanded = expand
        if (expand) {
            collapsedView?.visibility = View.GONE
            expandedView?.visibility = View.VISIBLE
        } else {
            expandedView?.visibility = View.GONE
            collapsedView?.visibility = View.VISIBLE
        }
    }

    private fun updateUIState(params: ReadableMap?) {
        if (params == null) return
        val isMic = if (params.hasKey("isMicActive")) params.getBoolean("isMicActive") else false
        val isCam = if (params.hasKey("isCameraActive")) params.getBoolean("isCameraActive") else false

        micButton?.apply {
            text = if (isMic) "🎙️ Aktif" else "🔇 Mic"
            background = createRoundedDrawable(if (isMic) "#16a34a" else "#334155", 8f)
            setTextColor(Color.parseColor(if (isMic) "#ffffff" else "#cbd5e1"))
        }

        camButton?.apply {
            text = if (isCam) "📷 On" else "📷 Off"
            background = createRoundedDrawable(if (isCam) "#16a34a" else "#334155", 8f)
            setTextColor(Color.parseColor(if (isCam) "#ffffff" else "#cbd5e1"))
        }
    }
}
