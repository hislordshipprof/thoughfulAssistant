import fs from 'fs';
import path from 'path';

/** Max file size (10 MB) to prevent OOM on huge uploads */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface FileExtractionResult {
  success: boolean;
  text: string;
  fileName: string;
  error?: string;
}

export async function extractTextFromFile(filePath: string): Promise<FileExtractionResult> {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return { success: false, text: '', fileName, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.` };
    }

    const buffer = fs.readFileSync(filePath);

    switch (ext) {
      case '.txt':
      case '.md': {
        return { success: true, text: buffer.toString('utf-8'), fileName };
      }

      case '.pdf': {
        const { PDFParse } = await import('pdf-parse');
        const uint8 = new Uint8Array(buffer);
        const parser = new PDFParse(uint8);
        const data = await parser.getText();
        const text = data.pages.map((p: any) => p.text).join('\n');
        return { success: true, text, fileName };
      }

      case '.docx': {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        return { success: true, text: result.value, fileName };
      }

      default:
        return { success: false, text: '', fileName, error: `Unsupported file type: ${ext}` };
    }
  } catch (err: any) {
    return { success: false, text: '', fileName, error: err.message || 'Failed to extract text' };
  }
}
