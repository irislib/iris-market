plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}
android {
    namespace = "to.iris.market"
    compileSdk = 36
    ndkVersion = "28.2.13676358"
    defaultConfig {
        applicationId = "to.iris.market"
        minSdk = 29
        targetSdk = 36
        versionCode = providers.environmentVariable("MARKET_ANDROID_VERSION_CODE").orNull?.toInt() ?: 10
        versionName = providers.environmentVariable("MARKET_RELEASE_VERSION").orNull ?: "0.1.3-alpha.3"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += "arm64-v8a" }
    }
    signingConfigs {
        create("release") {
            providers.environmentVariable("MARKET_ANDROID_KEYSTORE").orNull?.let { storeFile = file(it) }
            storePassword = providers.environmentVariable("MARKET_ANDROID_STORE_PASSWORD").orNull
            keyAlias = providers.environmentVariable("MARKET_ANDROID_KEY_ALIAS").orNull
            keyPassword = providers.environmentVariable("MARKET_ANDROID_KEY_PASSWORD").orNull
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-dev" }
        release {
            isMinifyEnabled = false
            if (providers.environmentVariable("MARKET_ANDROID_UNSIGNED_RELEASE").orNull != "1") {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.named("main") {
        jniLibs.srcDir(providers.environmentVariable("MARKET_ANDROID_JNI_DIR").orNull ?: layout.buildDirectory.dir("generated/jniLibs").get().asFile)
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    if (!name.contains("Test")) source(providers.environmentVariable("MARKET_ANDROID_BINDINGS_DIR").orNull ?: layout.buildDirectory.dir("generated/uniffi").get().asFile)
}
dependencyLocking { lockAllConfigurations() }
dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    // Apache-2.0; exact Google Maven payloads are pinned in verification-metadata.xml.
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.13.0")
    implementation(platform("androidx.compose:compose-bom:2025.09.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("net.java.dev.jna:jna:5.12.0@aar")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.09.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
