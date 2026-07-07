import os

files = [
    "privacy-windows.html",
    "privacy-macos.html",
    "privacy-ios.html",
    "privacy-android.html"
]

for filename in files:
    filepath = os.path.join("/Users/barretlin/GitProjects/OCR/docs", filename)
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    css_addition = """
        @media (max-width: 768px) {
            header {
                flex-direction: column;
                padding: 20px 24px;
                gap: 16px;
            }
            .container {
                margin: 20px 16px;
                padding: 24px;
            }
            h1 { font-size: 28px; }
        }
    </style>"""
    
    content = content.replace("</style>", css_addition)
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

print("Updated all privacy html files for RWD.")
