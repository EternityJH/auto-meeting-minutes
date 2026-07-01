import os
import sys

def generate_placeholder_icons():
    # If PIL (Pillow) is not available, we can try to install it.
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("Pillow is not installed. Attempting to install pillow...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pillow"])
        from PIL import Image, ImageDraw, ImageFont

    # Create icons directory if it doesn't exist
    os.makedirs("icons", exist_ok=True)

    sizes = [16, 48, 128]
    
    for size in sizes:
        # Create an image with transparent background
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # Draw a beautiful circle with deep purple gradient/colors
        # Dark purple: (103, 58, 183) to Cyan (0, 188, 212)
        # For simplicity, a smooth round circle with purple background
        margin = max(1, size // 12)
        draw.ellipse(
            [margin, margin, size - margin, size - margin],
            fill=(124, 77, 255, 255),  # Deep violet
            outline=(255, 255, 255, 255),
            width=max(1, size // 24)
        )
        
        # Draw a inner pulsing dot (indicating recording)
        dot_margin = size // 3
        draw.ellipse(
            [dot_margin, dot_margin, size - dot_margin, size - dot_margin],
            fill=(255, 23, 68, 255)  # Vibrant red dot
        )
        
        # Save to icons/icon{size}.png
        img.save(f"icons/icon{size}.png", "PNG")
        print(f"Generated icons/icon{size}.png")

if __name__ == "__main__":
    generate_placeholder_icons()
