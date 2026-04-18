from docx import Document
import os

template_path = r"d:\OneDrive - OTSI\Documents\AITesting_PromodDutta\TestPlan_TC_Generator\Templates\Test Plan - Template.docx"
try:
    doc = Document(template_path)
    print("Styles available in template:")
    for style in doc.styles:
        if style.type == 1: # Paragraph style
            print(f"  {style.name}")
except Exception as e:
    print(f"Error loading template: {e}")
