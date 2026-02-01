import { createDefaultInputConfig, InputManager, DEFAULT_SHORTCUTS } from "./src/input";
import { simulateEvent, EventTypeValue } from "rdev-node";

async function main() {
    const config = createDefaultInputConfig();
    const manager = new InputManager();
    
    // Register a test handler for the toggle-camera shortcut
    manager.register(DEFAULT_SHORTCUTS["toggle-camera"], () => {
        console.log('✅ Shortcut Ctrl+Shift+C triggered!');
    });
    
    // Register handlers for other shortcuts
    manager.register(DEFAULT_SHORTCUTS.screenshot, () => {
        console.log('✅ Screenshot shortcut triggered!');
    });
    
    manager.register(DEFAULT_SHORTCUTS["hide-window"], () => {
        console.log('✅ Hide window shortcut triggered!');
    });
    
    manager.register(DEFAULT_SHORTCUTS["position-top-left"], () => {
        console.log('✅ Position top-left shortcut triggered!');
    });
    
}

main();
