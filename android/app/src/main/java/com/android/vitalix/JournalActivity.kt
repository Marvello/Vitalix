package com.android.vitalix

import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.android.vitalix.databinding.ActivityJournalBinding
import com.google.android.material.chip.Chip
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Manual journal: mood, caffeine, alcohol, symptoms, medication, note, plus today's entries (deletable). */
class JournalActivity : AppCompatActivity() {

    private lateinit var b: ActivityJournalBinding
    private val client by lazy { JournalClient(this) }
    private var caffeine = 0
    private var alcohol = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityJournalBinding.inflate(layoutInflater)
        setContentView(b.root)
        applySystemBarsPadding()

        for (n in 1..5) {
            b.rowMood.addView(Button(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = n.toString()
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener { add("mood", num = n) }
            })
        }
        for (s in listOf("headache", "fatigue", "nausea", "sore throat", "stress")) {
            b.chipsSymptoms.addView(Chip(this).apply { text = s; setOnClickListener { add("symptom", text = s) } })
        }

        b.btnCaffeineMinus.setOnClickListener { caffeine = (caffeine - 1).coerceAtLeast(0); b.txtCaffeine.text = "$caffeine" }
        b.btnCaffeinePlus.setOnClickListener { caffeine = (caffeine + 1).coerceAtMost(20); b.txtCaffeine.text = "$caffeine" }
        b.btnAlcoholMinus.setOnClickListener { alcohol = (alcohol - 1).coerceAtLeast(0); b.txtAlcohol.text = "$alcohol" }
        b.btnAlcoholPlus.setOnClickListener { alcohol = (alcohol + 1).coerceAtMost(30); b.txtAlcohol.text = "$alcohol" }
        b.btnCaffeineAdd.setOnClickListener {
            add("caffeine", num = caffeine) { caffeine = 0; b.txtCaffeine.text = "0" }
        }
        b.btnAlcoholAdd.setOnClickListener {
            add("alcohol", num = alcohol) { alcohol = 0; b.txtAlcohol.text = "0" }
        }
        b.btnSymptomAdd.setOnClickListener { addText("symptom", b.editSymptom) }
        b.btnMedicationAdd.setOnClickListener { addText("medication", b.editMedication) }
        b.btnNoteAdd.setOnClickListener { addText("note", b.editNote) }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun addText(kind: String, field: android.widget.EditText) {
        val text = field.text.toString().trim()
        if (text.isNotEmpty()) add(kind, text = text) { field.text = null }
    }

    private fun add(kind: String, num: Int? = null, text: String? = null, onSaved: () -> Unit = {}) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { client.add(kind, num, text) }
            if (ok) { onSaved(); refresh() } else toast(R.string.journal_save_failed)
        }
    }

    private fun refresh() {
        lifecycleScope.launch {
            val entries = withContext(Dispatchers.IO) { client.today() }
            if (entries == null) { toast(R.string.journal_load_failed); return@launch }
            b.listEntries.removeAllViews()
            b.txtEmpty.visibility = if (entries.isEmpty()) android.view.View.VISIBLE else android.view.View.GONE
            entries.forEach { e ->
                b.listEntries.addView(LinearLayout(this@JournalActivity).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(TextView(context).apply {
                        text = e.label()
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    })
                    addView(Button(context, null, androidx.appcompat.R.attr.borderlessButtonStyle).apply {
                        text = getString(R.string.journal_delete)
                        setTextColor(getColor(R.color.vital_teal_text))
                        setOnClickListener { delete(e.id) }
                    })
                })
            }
        }
    }

    private fun delete(id: Long) {
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) { client.delete(id) }
            if (ok) refresh() else toast(R.string.journal_save_failed)
        }
    }

    private fun toast(res: Int) = Toast.makeText(this, res, Toast.LENGTH_SHORT).show()
}
