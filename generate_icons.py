# generate_icons.py - Generate Chrome Extension PNG Icons

import os
import zlib
import struct

output_dir = "/Users/deathgun/Documents/adultsite/video-downloader-extension/icons"
os.makedirs(output_dir, exist_ok=True)

# Try drawing premium vectors if Pillow is installed
try:
    from PIL import Image, ImageDraw
    print("[StreamGrab] Pillow detected, drawing high-quality gradient icons...")
    
    def create_gradient_icon(size):
        # Create image with transparent background
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # Draw background glowing circle
        padding = max(1, size // 12)
        
        # Primary circle background - violet glow
        draw.ellipse([padding, padding, size - padding, size - padding], fill=(139, 92, 246, 255))
        
        # Inner decorative highlight circle - pink gradient touch
        inner_padding = padding + max(1, size // 10)
        draw.ellipse([inner_padding, inner_padding, size - inner_padding, size - inner_padding], fill=(168, 85, 247, 255))
        
        # Draw a downward play button (representing video downloading)
        center_x = size // 2
        center_y = size // 2
        r = size // 4
        
        pt1 = (center_x - r, center_y - r // 2)
        pt2 = (center_x + r, center_y - r // 2)
        pt3 = (center_x, center_y + r)
        
        # Draw download arrow (triangle) in white
        draw.polygon([pt1, pt2, pt3], fill=(255, 255, 255, 255))
        
        # Draw a white outline for sizes 48 and 128
        if size >= 48:
            draw.ellipse([padding, padding, size - padding, size - padding], outline=(255, 255, 255, 60), width=2)
            
        img.save(os.path.join(output_dir, f"icon{size}.png"))

    for s in [16, 32, 48, 128]:
        create_gradient_icon(s)
    print("[StreamGrab] Premium icons generated successfully.")

except ImportError:
    print("[StreamGrab] Pillow not found. Running custom zlib PNG compiler...")
    
    def compile_png(filename, width, height, r, g, b, a):
        # PNG Signature
        signature = b'\x89PNG\r\n\x1a\n'
        
        # IHDR (Image Header)
        # Width: 4 bytes, Height: 4 bytes, Bit Depth: 1 byte, Color Type: 1 byte (6 = RGBA)
        # Compression: 1 byte, Filter: 1 byte, Interlace: 1 byte
        ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
        ihdr_chunk = struct.pack('>I', 13) + b'IHDR' + ihdr_data + struct.pack('>I', zlib.crc32(b'IHDR' + ihdr_data))
        
        # IDAT (Pixel Data)
        # 1 byte filter type (0 = None) followed by RGBA bytes for each pixel
        pixel_bytes = bytes([r, g, b, a])
        row = b'\x00' + (pixel_bytes * width)
        img_data = row * height
        
        compressed = zlib.compress(img_data)
        idat_chunk = struct.pack('>I', len(compressed)) + b'IDAT' + compressed + struct.pack('>I', zlib.crc32(b'IDAT' + compressed))
        
        # IEND (Image Trailer)
        iend_chunk = struct.pack('>I', 0) + b'IEND' + struct.pack('>I', zlib.crc32(b'IEND'))
        
        # Write binary
        with open(os.path.join(output_dir, filename), 'wb') as f:
            f.write(signature + ihdr_chunk + idat_chunk + iend_chunk)

    # Compile beautiful solid violet files
    for s in [16, 32, 48, 128]:
        compile_png(f"icon{s}.png", s, s, 139, 92, 246, 255)
        
    print("[StreamGrab] Standard violet PNG icons successfully written.")
