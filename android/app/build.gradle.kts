import java.net.DatagramSocket
import java.net.InetAddress
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

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
        version = release(37)
    }

    signingConfigs {
        create("beta") {
            storeFile = file(project.findProperty("VITALIX_BETA_STORE_FILE") as String? ?: "")
            storePassword = project.findProperty("VITALIX_BETA_STORE_PASSWORD") as String? ?: ""
            keyAlias = project.findProperty("VITALIX_BETA_KEY_ALIAS") as String? ?: ""
            keyPassword = project.findProperty("VITALIX_BETA_KEY_PASSWORD") as String? ?: ""
        }
        create("production") {
            storeFile = file(project.findProperty("VITALIX_PROD_STORE_FILE") as String? ?: "")
            storePassword = project.findProperty("VITALIX_PROD_STORE_PASSWORD") as String? ?: ""
            keyAlias = project.findProperty("VITALIX_PROD_KEY_ALIAS") as String? ?: ""
            keyPassword = project.findProperty("VITALIX_PROD_KEY_PASSWORD") as String? ?: ""
        }
    }

    defaultConfig {
        applicationId = "com.android.vitalix"
        minSdk = 30
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"

        // Stamp the build time so the Settings footer can show which build is
        // installed. Local time, minute precision — enough to tell two builds apart.
        val buildTime = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
            .withZone(ZoneId.systemDefault())
            .format(Instant.now())
        buildConfigField("String", "BUILD_TIME", "\"$buildTime\"")

        val clarityId = (project.findProperty("clarityProjectId") as String?)
            ?: System.getenv("CLARITY_PROJECT_ID")
            ?: ""
        buildConfigField("String", "CLARITY_PROJECT_ID", "\"$clarityId\"")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_SERVER_URL", serverUrl(defaultDebugServerUrl()))
        }
        create("beta") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("beta")
            buildConfigField("String", "DEFAULT_SERVER_URL", serverUrl(""))
            applicationIdSuffix = ".beta"
            versionNameSuffix = "-beta"
        }
        release {
            signingConfig = signingConfigs.getByName("production")
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
    implementation(libs.clarity)
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.json)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.mockito.core)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}