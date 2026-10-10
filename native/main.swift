import AppKit
import SwiftUI

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = UsageModel()
    var item: NSStatusItem!
    let popover = NSPopover()
    var previewWindow: NSWindow?
    var firstDisplay = true
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: 32)
        item.autosaveName = "CodexUsageCompact"
        if let button = item.button {
            updateMenuImage()
            button.target = self; button.action = #selector(togglePanel)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.setAccessibilityLabel("Codex 用量，點一下展開")
        }
        popover.behavior = .semitransient
        popover.animates = false
        popover.contentSize = NSSize(width: 336, height: 330)
        popover.contentViewController = NSHostingController(rootView: UsageView(model: model))
        model.closePanel = { [weak self] in self?.popover.performClose(nil) }
        model.changes = { [weak self] in
            guard let self else { return }
            self.updateMenuImage()
            self.item.button?.toolTip = self.model.tooltip
            self.item.button?.setAccessibilityValue(self.model.tooltip)
            if self.firstDisplay && self.model.connected {
                self.firstDisplay = false
                self.showPanel()
            }
        }
        model.start()
        if CommandLine.arguments.contains("--preview-window") {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 336, height: 330), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Codex 用量（驗證視窗）"
            window.contentViewController = NSHostingController(rootView: UsageView(model: model))
            window.center(); window.makeKeyAndOrderFront(nil); previewWindow = window
        }
    }
    func updateMenuImage() {
        let primary = percentage(model.window("primary")?.remainingPercent)
        let secondary = percentage(model.window("secondary")?.remainingPercent)
        let alpha: CGFloat = model.old ? 0.55 : 1
        let image = NSImage(size: NSSize(width: 28, height: 22), flipped: false) { _ in
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
                .foregroundColor: NSColor.black.withAlphaComponent(alpha),
                .paragraphStyle: paragraph
            ]
            (primary as NSString)
                .draw(in: NSRect(x: 0, y: 11, width: 28, height: 11), withAttributes: attributes)
            (secondary as NSString)
                .draw(in: NSRect(x: 0, y: 0, width: 28, height: 11), withAttributes: attributes)
            return true
        }
        image.isTemplate = true
        item.button?.title = ""
        item.button?.image = image
        item.button?.imagePosition = .imageOnly
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return false
    }
    @objc func togglePanel() {
        guard let button = item.button else { return }
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            let show = NSMenuItem(title: "展開用量", action: #selector(showPanel), keyEquivalent: "")
            show.target = self; menu.addItem(show)
            let quit = NSMenuItem(title: "退出 Codex 用量", action: #selector(quit), keyEquivalent: "")
            quit.target = self; menu.addItem(quit)
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height), in: button)
        } else if popover.isShown { popover.performClose(nil) }
        else { showPanel() }
    }
    @objc func showPanel() {
        guard let button = item.button else { return }
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) { model.stop() }
}

@main struct NativeMain {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--quit") {
            let applications = NSRunningApplication.runningApplications(withBundleIdentifier: "local.codex.usagepanel")
                .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
            guard !applications.isEmpty else { exit(3) }
            applications.forEach { _ = $0.terminate() }
            print("已通知原生用量面板退出。")
            return
        }
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
