package com.android.vitalix

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class VitalixFirebaseService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        Log.d(TAG, "FCM token refreshed")
        // Token registration with server is implemented in Task 5
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        Log.d(TAG, "FCM message received: type=${data["type"]}")
        // Update notification handling is implemented in Task 5
    }

    companion object {
        private const val TAG = "VitalixFCM"
    }
}
