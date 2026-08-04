---
status: Specs Created
---

# Bug fixes
1. There is error 413 in one of the user, it's manual sync can you make sure we already implement chucking

# Enhancement
1. In the Invite Email, Please also add QR for App Download too.
2. Split the android package name `com.android.vitalix` for Production and `com.android.vitalix.beta` for Beta
3. Add Firebase SDK
- Add the dependency for the Google services Gradle plugin Version 4.5.0
- Module (app-level) Gradle file (<project>/<app-module>/build.gradle.kts):
4. We need to add feature in the app to check for new update. There are 2 mechanism: 
- Manual Check when user open the app. Follow the guide here https://zealot.ews.im/docs/developer-guide/sdk/android
- Open API in the Web to receive webhook from the Zealot whenever there is an update. If the web receive the update webhook then send notification via firebase to the user informing there is new update on the app
5. If there is an update, please manage the update inside the app. Download the new apk, when the apk is finish downloading offer to install the apps.


