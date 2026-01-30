import { 
  TrayIconBuilder, 
  Menu, 
  MenuItemBuilder,
  Icon,
  initialize,
  update,
  pollTrayEvents,
  pollMenuEvents,
  CheckMenuItemBuilder,
  SubmenuBuilder, PredefinedMenuItem } from 'tray-icon-node';
/**
 * Generates a simple 32x32 red icon as a Buffer.
 * @returns {Buffer}
 */
export function generateIconData() {
  const iconData = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    iconData[i * 4 + 0] = 255; // R
    iconData[i * 4 + 1] = 0;   // G
    iconData[i * 4 + 2] = 0;   // B
    iconData[i * 4 + 3] = 255; // A
  }
  return iconData;
}
export function createTrayMenu() {
  const menu = new Menu();

  // 1. Standard Item
  const helloItem = new MenuItemBuilder()
    .withText("Say Hello")
    .withId("hello")
    .build();

  // 2. Checkbox Item in the Main Menu
  const toggleItem = new CheckMenuItemBuilder()
    .withText("Notifications Enabled")
    .withId("toggle_notif")
    .withChecked(true) // Initial state
    .build();

  // 3. Submenu with a Checkbox inside
  const subMenu = new SubmenuBuilder()
    .withText("More Options")
    .build();

  subMenu.appendMenuItem(
    new MenuItemBuilder().withText("Sub Item 1").withId("sub1").build()
  );

  // Adding a checkbox to the SUBMENU
  subMenu.appendCheckMenuItem(
    new CheckMenuItemBuilder()
      .withText("Enable Turbo Mode")
      .withId("turbo_mode")
      .withChecked(false)
      .build()
  );

  // Build the main menu structure
  menu.appendMenuItem(helloItem);
  menu.appendCheckMenuItem(toggleItem,"toggle_notif"); // Append the checkbox
  menu.appendSubmenu(subMenu);
  menu.appendPredefinedMenuItem(PredefinedMenuItem.separator());
  
  const quitItem = new MenuItemBuilder()
    .withText("Exit")
    .withId("quit")
    .build();
  menu.appendMenuItem(quitItem);
  return {menu,subMenu,toggleItem,helloItem};
}

// Global reference to prevent Garbage Collection
let tray = null;
let isRunning = true;

/**
 * Handles incoming events from the tray and menu.
 */
function handleEvents(menu: Menu) {
  const trayEvent = pollTrayEvents();
  if (trayEvent && trayEvent.eventType) {
  //  console.log(trayEvent.eventType);
  }

  const menuEvent = pollMenuEvents();
  if (menuEvent) {
    console.log("Menu Event:", menuEvent);
    
    if (menuEvent.id === "hello") {
      console.log("Hello there!");
    }
    
    if (menuEvent.id === "quit") {
      isRunning = false;
    }
    const currentlyChecked = menu.isChecked("toggle_notif");
    menu.setText("toggle_notif", "Notifications: " + currentlyChecked);
    console.log({currentlyChecked})
  }
}

async function startApp() {
  console.log("Initializing Tray Icon...");
  
  initialize();

  const icon = Icon.fromRgba(generateIconData(), 32, 32);
  const {menu} = createTrayMenu();

  tray = new TrayIconBuilder()
    .withTitle("My App")
    .withTooltip("Right click for menu")
    .withIcon(icon)
    .withMenu(menu)
    .build();

  console.log("Tray successfully created.");

  // Main Event Loop
  while (isRunning) {
    update();       // Process Windows messages (via Rust)
    handleEvents(menu);  // Process internal event queues
    
    // Small delay to prevent high CPU usage (~30 FPS)
    await new Promise((resolve) => setTimeout(resolve, 32));
  }

  console.log("Shutting down...");
  tray = null;
  process.exit(0);
}

// Non-blocking background task
setInterval(() => console.log("Heartbeat..."), 10000);

startApp().catch(console.error);