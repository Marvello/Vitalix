package com.android.vitalix

import android.app.DownloadManager
import android.content.Intent
import android.content.Context
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BulletSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.databinding.ActivityUpdateBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class UpdateActivity : AppCompatActivity() {

    private lateinit var binding: ActivityUpdateBinding
    private lateinit var updateManager: UpdateManager
    private lateinit var updateInfo: UpdateInfo

    private var downloadId: Long = -1
    private var progressJob: Job? = null

    private enum class State { READY, DOWNLOADING, DOWNLOADED, ERROR }
    private var state = State.READY

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityUpdateBinding.inflate(layoutInflater)
        setContentView(binding.root)

        updateInfo = IntentCompat.getParcelableExtra(
            intent, UpdateManager.EXTRA_UPDATE_INFO, UpdateInfo::class.java
        ) ?: run { finish(); return }

        updateManager = UpdateManager(this)

        downloadId = savedInstanceState?.getLong(KEY_DOWNLOAD_ID, -1) ?: -1

        binding.txtVersion.text = "v${updateInfo.versionName}"
        renderChangelog(updateInfo.changelog)
        applyNavBarInset()

        binding.btnPrimary.setOnClickListener { onPrimaryClicked() }
        binding.btnNotNow.setOnClickListener { onNotNowClicked() }

        if (downloadId != -1L) {
            resumeProgressTracking()
        } else {
            setState(State.READY)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLong(KEY_DOWNLOAD_ID, downloadId)
    }

    override fun onDestroy() {
        progressJob?.cancel()
        super.onDestroy()
    }

    private fun onPrimaryClicked() {
        when (state) {
            State.READY -> startDownload()
            State.DOWNLOADING -> cancelDownload()
            State.DOWNLOADED -> installApk()
            State.ERROR -> startDownload()
        }
    }

    private fun onNotNowClicked() {
        if (state == State.DOWNLOADING) {
            updateManager.cancelDownload(downloadId)
        }
        finish()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        onNotNowClicked()
    }

    private fun startDownload() {
        setState(State.DOWNLOADING)
        downloadId = updateManager.downloadApk(updateInfo.downloadUrl, updateInfo.versionName)
        startProgressTracking()
    }

    private fun cancelDownload() {
        progressJob?.cancel()
        updateManager.cancelDownload(downloadId)
        downloadId = -1
        setState(State.READY)
    }

    private fun installApk() {
        val uri = updateManager.getApkUri(downloadId)
        if (uri == null) {
            showError("Downloaded file not found. Try again.")
            setState(State.ERROR)
            return
        }
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(install)
    }

    private fun resumeProgressTracking() {
        lifecycleScope.launch {
            val progress = withContext(Dispatchers.IO) { updateManager.queryProgress(downloadId) }
            when (progress.status) {
                DownloadManager.STATUS_SUCCESSFUL -> setState(State.DOWNLOADED)
                DownloadManager.STATUS_FAILED -> {
                    showError("Download failed. Tap Retry.")
                    setState(State.ERROR)
                }
                else -> {
                    setState(State.DOWNLOADING)
                    startProgressTracking()
                }
            }
        }
    }

    private fun startProgressTracking() {
        progressJob?.cancel()
        progressJob = lifecycleScope.launch {
            while (isActive) {
                val progress = withContext(Dispatchers.IO) {
                    updateManager.queryProgress(downloadId)
                }
                when (progress.status) {
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        binding.progressDownload.progress = 100
                        binding.txtProgress.text = "100%"
                        setState(State.DOWNLOADED)
                        return@launch
                    }
                    DownloadManager.STATUS_FAILED -> {
                        showError("Download failed. Tap Retry.")
                        setState(State.ERROR)
                        return@launch
                    }
                    else -> {
                        if (progress.bytesTotal > 0) {
                            val pct = (progress.bytesDownloaded * 100 / progress.bytesTotal).toInt()
                            binding.progressDownload.progress = pct
                            binding.txtProgress.text = "$pct%"
                        }
                    }
                }
                delay(300)
            }
        }
    }

    private fun setState(newState: State) {
        state = newState
        when (newState) {
            State.READY -> {
                binding.btnPrimary.text = getString(R.string.update_download)
                binding.progressDownload.visibility = View.GONE
                binding.txtProgress.visibility = View.GONE
                binding.txtError.visibility = View.GONE
            }
            State.DOWNLOADING -> {
                binding.btnPrimary.text = getString(R.string.update_cancel)
                binding.progressDownload.visibility = View.VISIBLE
                binding.progressDownload.progress = 0
                binding.txtProgress.visibility = View.VISIBLE
                binding.txtProgress.text = "0%"
                binding.txtError.visibility = View.GONE
            }
            State.DOWNLOADED -> {
                binding.btnPrimary.text = getString(R.string.update_install)
                binding.progressDownload.visibility = View.GONE
                binding.txtProgress.visibility = View.GONE
                binding.txtError.visibility = View.GONE
            }
            State.ERROR -> {
                binding.btnPrimary.text = getString(R.string.update_retry)
                binding.progressDownload.visibility = View.GONE
                binding.txtProgress.visibility = View.GONE
            }
        }
    }

    private fun showError(message: String) {
        binding.txtError.text = message
        binding.txtError.visibility = View.VISIBLE
    }

    private fun renderChangelog(raw: String) {
        if (raw.isBlank()) {
            binding.scrollChangelog.visibility = View.GONE
            return
        }
        val ssb = SpannableStringBuilder()
        for (line in raw.lines()) {
            when {
                line.startsWith("### ") || line.startsWith("## ") -> {
                    val text = line.removePrefix("### ").removePrefix("## ")
                    val start = ssb.length
                    ssb.append(text).append("\n")
                    ssb.setSpan(StyleSpan(Typeface.BOLD), start, start + text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    ssb.setSpan(RelativeSizeSpan(1.1f), start, start + text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                line.startsWith("- ") || line.startsWith("* ") -> {
                    val text = line.removePrefix("- ").removePrefix("* ")
                    val start = ssb.length
                    ssb.append(text).append("\n")
                    ssb.setSpan(BulletSpan(16), start, ssb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                line.isBlank() -> ssb.append("\n")
                else -> ssb.append(line).append("\n")
            }
        }
        binding.txtChangelog.text = ssb
    }

    private fun applyNavBarInset() {
        val bar = binding.barButtons
        val basePadding = bar.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(bar) { view, insets ->
            val bottom = insets.getInsets(
                WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.systemGestures()
            ).bottom
            view.updatePadding(bottom = basePadding + bottom)
            insets
        }
        ViewCompat.requestApplyInsets(bar)
    }

    companion object {
        private const val KEY_DOWNLOAD_ID = "download_id"

        fun intent(context: Context, info: UpdateInfo): Intent =
            Intent(context, UpdateActivity::class.java)
                .putExtra(UpdateManager.EXTRA_UPDATE_INFO, info)
    }
}
