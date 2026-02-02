import { Resvg } from '@resvg/resvg-js';
import fs from 'fs/promises';
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function iconBuffer() {
    const svgContent = await fs.readFile(path.join(__dirname, "webcam.svg"));
    
    // Configurar resvg con el ancho deseado
    const resvg = new Resvg(svgContent, {
        fitTo: {
            mode: 'width', // o 'height'
            value: 32,
        },
    });

    const image = resvg.render();
    
    // 'pixels' contiene el Buffer Raw (RGBA) igual que sharp().raw()
    return image.pixels; 
}