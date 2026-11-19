# -*- coding: utf-8 -*-
"""Genera icono.ico (calendario azul con un 24) para el .exe."""
from PIL import Image, ImageDraw, ImageFont

AZUL = (32, 86, 170, 255)
AZUL_OSC = (22, 60, 122, 255)
CREMA = (250, 251, 253, 255)
SOMBRA = (14, 40, 84, 60)

S = 1024  # se dibuja grande y se achica con antialias
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# fondo redondeado
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=AZUL)

# hoja del calendario
m = int(S * 0.16)
hoja = [m, int(S * 0.20), S - m, S - int(S * 0.16)]
d.rounded_rectangle(hoja, radius=int(S * 0.06), fill=CREMA)

# cabecera azul de la hoja
anillo = int(S * 0.075)
d.rounded_rectangle([hoja[0], hoja[1], hoja[2], hoja[1] + anillo], radius=int(S * 0.06), fill=AZUL_OSC)
d.rectangle([hoja[0], hoja[1] + anillo // 2, hoja[2], hoja[1] + anillo], fill=AZUL_OSC)

# argollas
for x in (0.36, 0.64):
    cx = int(S * x)
    d.rounded_rectangle([cx - int(S * 0.022), int(S * 0.13), cx + int(S * 0.022), int(S * 0.27)],
                        radius=int(S * 0.022), fill=CREMA)

# "24"
try:
    fuente = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", int(S * 0.42))
except Exception:
    fuente = ImageFont.load_default()
txt = "24"
caja = d.textbbox((0, 0), txt, font=fuente)
tx = (S - (caja[2] - caja[0])) / 2 - caja[0]
ty = int(S * 0.40) - caja[1]
d.text((tx, ty), txt, font=fuente, fill=AZUL)

img.resize((256, 256), Image.LANCZOS).save("icono.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icono.ico generado")
