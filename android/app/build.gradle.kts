import java.net.DatagramSocket
import java.net.InetAddress

plugins {
    alias(libs.plugins.android.application)
}

/**
 * Debug default: the machine's LAN address, not localhost. localhost only works
 * through an `adb reverse` tunnel, which drops when the device screen sleeps —
 * fatal for a long background backfill. Falls back to the tunnel if no LAN
 * address can be determined.
 */
fun defaultDebugServerUrl(): String {
    // Ask the routing table which local address would be used to reach the
    // outside world. Enumerating interfaces instead picks up virtual ones
    // (Docker, VPNs) that the phone cannot route to. No packets are sent.
    val host: String = try {
        DatagramSocket().use { socket ->
            socket.connect(InetAddress.getByName("8.8.8.8"), 53)
            socket.localAddress.hostAddress
        } ?: "localhost"
    } catch (e: Exception) {
        "localhost"
    }
    return "http://$host:3000/api/health"
}

/**
 * Build-time server URL. The `vitalixServerUrl` Gradle property (or the
 * VITALIX_SERVER_URL environment variable) wins, otherwise the per-build-type
 * default below. Quoted for buildConfigField, which takes a Java literal.
 */
fun serverUrl(default: String): String {
    val value = (project.findProperty("vitalixServerUrl") as String?)
        ?: System.getenv("VITALIX_SERVER_URL")
        ?: default
    return "\"$value\""
}

android {
    namespace = "com.android.vitalix"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.android.vitalix"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_SERVER_URL", serverUrl(defaultDebugServerUrl()))
        }
        release {
            // Set at build time, e.g. -PvitalixServerUrl=https://vitalix.example.com/api/health
            buildConfigField("String", "DEFAULT_SERVER_URL", serverUrl(""))
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        buildConfig = true
        viewBinding = true
    }
}

dependencies {
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    implementation(libs.health.connect.client)
    implementation(libs.okhttp)
    implementation(libs.json)
    implementation(libs.security.crypto)
    implementation(libs.work.runtime.ktx)
    implementation(libs.coroutines.android)
    implementation(libs.kotlin.reflect)
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.json)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}