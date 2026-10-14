import { BaseParser } from './base-parser.js';
import { ParseResult } from '../../../types/transaction.js';
import { KotakCsvParser } from './kotak-csv-parser.js';
import { KvbCsvParser } from './kvb-csv-parser.js';
import { HdfcXlsParser } from './hdfc-xls-parser.js';
import { AxisXlsParser } from './axis-xls-parser.js';
import { KotakPdfParser } from './kotak-pdf-parser.js';
import { IdfcXlsParser } from './idfc-xls-parser.js';

export class ParserFactory {
  static getParser(fileName: string, fileBuffer: Buffer): BaseParser | null {
    const extension = fileName.split('.').pop()?.toLowerCase();
    // Determine parser based on file extension and content
    if (extension === 'csv') {
      // Check if it's Kotak CSV
      const content = fileBuffer.toString('utf-8');
      if (content.includes('Kotak') || content.includes('KKBK')) {
        return new KotakCsvParser();
      }
      // Check if it's KVB CSV
      if (content.includes('Account Activity') || content.includes('Account Number')) {
        return new KvbCsvParser();
      }
    } else if (extension === 'xls' || extension === 'xlsx') {
      // Check bank name from file name or content
      if (fileName.toLowerCase().includes('hdfc')) {
        return new HdfcXlsParser();
      } else if (fileName.toLowerCase().includes('axis')) {
        return new AxisXlsParser();
      } else if (fileName.toLowerCase().includes('idfc')) {
        return new IdfcXlsParser();
      }
    } else if (extension === 'pdf') {
      // Check if it's Kotak PDF
      if (fileName.toLowerCase().includes('kotak')) {
        return new KotakPdfParser();
      }
    }
    
    return null;
  }

  static async parseFile(fileName: string, fileBuffer: Buffer): Promise<ParseResult> {
    const parser = this.getParser(fileName, fileBuffer);
    
    if (!parser) {
      return {
        transactions: [],
        errors: [`Unsupported file format or bank: ${fileName}`],
      };
    }

    try {
      return await parser.parse(fileBuffer, fileName);
    } catch (error) {
      return {
        transactions: [],
        errors: [`Error parsing file: ${error instanceof Error ? error.message : 'Unknown error'}`],
      };
    }
  }
}

