import { createDefaultInputConfig,InputManager } from "./src/input";
async function main() {
    const config = createDefaultInputConfig()
    const manager = new InputManager(config)
    manager.initialize()
}main()