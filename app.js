App({
  globalData: {},
  onCreate() {},
  onDestroy() {
    // Drop BLE cleanly when the app closes.
    const s = this.globalData.session
    if (s) {
      s.radio.shutdown()
      s.link.stop()
    }
  }
})
