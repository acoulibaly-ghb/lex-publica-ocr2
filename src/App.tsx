/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  FileText,
  Upload,
  Copy,
  Check,
  Loader2,
  AlertCircle,
  Image as ImageIcon,
  FileSearch,
  Download,
  Trash2
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';
import * as pdfjsLib from 'pdfjs-dist';

// Configuration de PDF.js pour utiliser le décodeur WASM
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
pdfjsLib.GlobalWorkerOptions.cMapUrl = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/cmaps/`;
pdfjsLib.GlobalWorkerOptions.cMapPacked = true;

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface OCRResult {
  text: string;
  timestamp: number;
  fileName: string;
  metadata?: {
    date?: string;
    caseNumber?: string;
    parties?: string[];
  };
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<OCRResult | null>(null);
  const [history, setHistory] = useState<OCRResult[]>(() => {
    const saved = localStorage.getItem('ocr_history');
    return saved ? JSON.parse(saved) : [];
  });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showCitation, setShowCitation] = useState(false);
  const [citation, setCitation] = useState("");

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setError(null);
    setFiles(acceptedFiles);

    const newPreviews: string[] = [];
    let pageCount = 0;
    for (const file of acceptedFiles) {
      if (file.type === 'application/pdf') {
        try {
          const pdfPreviews = await generatePdfPreviews(file);
          newPreviews.push(...pdfPreviews);
          pageCount = pdfPreviews.length;
        } catch (err) {
          console.error("PDF Preview Error:", err);
          newPreviews.push('');
        }
      } else {
        newPreviews.push(URL.createObjectURL(file));
        pageCount = 1;
      }
    }
    setPreviews(newPreviews);
    setPdfPageCount(pageCount);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.webp'],
      'application/pdf': ['.pdf']
    },
    multiple: false
  });

  const generatePdfPreviews = async (file: File, maxPages: number = 50): Promise<string[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      disableAutoFetch: false,
      cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
      cMapPacked: true,
    }).promise;

    const numPages = Math.min(pdf.numPages, maxPages);
    const pagePreviews: string[] = [];
    const scale = 1.2;

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;

      if (context) {
        await page.render({
          canvasContext: context,
          viewport,
        }).promise;

        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        if (dataUrl !== 'data:,' && dataUrl.length > 100) {
          pagePreviews.push(dataUrl);
        }
      }
    }

    if (pagePreviews.length === 0) {
      throw new Error("Aucune page n'a pu être convertie en image.");
    }
    return pagePreviews;
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const extractMetadata = (text: string) => {
    const dateMatch = text.match(/Le (\d{1,2} \w+ \d{4})/);
    const caseNumberMatch = text.match(/ARRÊT N° (\d+)/i);
    const partiesMatch = text.match(/entre (.+?) et (.+?),/is);

    return {
      date: dateMatch ? dateMatch[0] : "Inconnue",
      caseNumber: caseNumberMatch ? `ARRÊT N° ${caseNumberMatch[1]}` : "Inconnu",
      parties: partiesMatch ? partiesMatch.slice(1) : [],
    };
  };

  const cleanText = (text: string) => {
  return text
    // Nettoyage des artefacts OCR
    .replace(/1ᵉʳ/g, "1er")
    .replace(/2ᵉ/g, "2e")
    .replace(/—/g, "-")
    .replace(/\[img-\d+\.jpeg\]/g, "")
    // 1. Réunir les mots coupés par un trait d'union en fin de ligne
    .replace(/-\s*\n\s*/g, "")
    // 2. Normaliser les sauts multiples (3+) en double saut (= séparateur de paragraphe)
    .replace(/(\s*\n\s*){3,}/g, "\n\n")
    // 3. Découper en paragraphes (séparés par des lignes vides)
    .split(/\n\n/)
    .map(paragraph =>
      // Dans chaque paragraphe, fusionner les sauts de ligne simples en espaces
      paragraph
        .replace(/\n/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
    )
    .filter(p => p.length > 0)
    .join("\n\n");
};





  const processOCR = async () => {
  if (files.length === 0) return;

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 Mo
  if (files[0].size > MAX_FILE_SIZE) {
    setError("Le fichier est trop volumineux (max 10 Mo).");
    return;
  }

  setIsProcessing(true);
  setError(null);
  setResult(null);
  setProgress(0);

  try {
    const arrayBuffer = await files[0].arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      disableAutoFetch: false,
      cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
      cMapPacked: true,
    }).promise;

    let fullText = "";
    const numPages = pdf.numPages;

    // Traiter chaque page du PDF
    for (let i = 1; i <= numPages; i++) {
      setProgress(((i - 1) / numPages) * 90);

      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      // Extraire le texte avec des sauts de ligne naturels
      // Extraire le texte avec détection intelligente des paragraphes
      let pageText = "";
      let lastY = -1;
      let lineSpacings: number[] = [];

      // Premier passage : calculer l'interligne moyen
      for (const item of textContent.items) {
        if (item.str && item.transform) {
          const currentY = item.transform[5];
          if (lastY !== -1) {
            const gap = Math.abs(currentY - lastY);
            if (gap > 1 && gap < 100) {
              lineSpacings.push(gap);
            }
          }
          lastY = currentY;
        }
      }

      // Calculer l'interligne médian
      lineSpacings.sort((a, b) => a - b);
      const medianSpacing = lineSpacings.length > 0
        ? lineSpacings[Math.floor(lineSpacings.length / 2)]
        : 12;
      const paragraphThreshold = medianSpacing * 1.8;

      // Deuxième passage : extraire le texte avec la bonne logique
      lastY = -1;
      for (const item of textContent.items) {
        if (item.str && item.transform) {
          const currentY = item.transform[5];

          if (lastY !== -1) {
            const gap = Math.abs(currentY - lastY);
            if (gap > paragraphThreshold) {
              pageText += "\n\n";
            } else if (gap > 1) {
              pageText += "\n";
            }
          }
          pageText += item.str + " ";
          lastY = currentY;
        }
      }
      fullText += pageText.trim() + "\n\n"; // Ajouter un double saut de ligne entre les pages
    }

    setProgress(95);

    // Nettoyer le texte extrait
    const cleanedText = cleanText(fullText);
    const metadata = extractMetadata(cleanedText);

    setProgress(100);

    const newResult = {
      text: cleanedText,
      timestamp: Date.now(),
      fileName: files[0].name,
      metadata: metadata,
    };

    setResult(newResult);
    const newHistory = [newResult, ...history].slice(0, 5);
    setHistory(newHistory);
    localStorage.setItem('ocr_history', JSON.stringify(newHistory));

  } catch (err: any) {
    console.error("Erreur complète :", err);
    setError(err.message || "Une erreur est survenue lors de l'extraction.");
  } finally {
    setIsProcessing(false);
  }
};

  const copyToClipboard = () => {
    if (result) {
      navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const generateCitation = () => {
    if (result) {
      const date = new Date(result.timestamp).toLocaleDateString('fr-FR');
      const baseName = result.fileName.replace(/\.[^/.]+$/, "").replace(/_/g, " ");
      const caseRef = result.metadata?.caseNumber || "Document juridique";
      const formatted = `${caseRef} (${result.metadata?.date || date}), extrait via Légiscribe OCR (Mistral AI)`;
      setCitation(formatted);
      setShowCitation(true);
    }
  };

  const downloadText = () => {
    if (result) {
      const blob = new Blob([result.text], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${result.fileName.split('.')[0]}_ocr.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const reset = () => {
    setFiles([]);
    setPreviews([]);
    setResult(null);
    setError(null);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('ocr_history');
  };

  const loadFromHistory = (item: OCRResult) => {
    setResult(item);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-[#D4AF37]/20 px-8 py-5 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="bg-zinc-900 p-2.5 rounded-lg shadow-inner">
            <FileSearch className="w-6 h-6 text-[#D4AF37]" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-bold text-zinc-900 mb-2">
              Légiscribe OCR
            </h1>
            <p className="text-[10px] text-[#D4AF37] font-bold uppercase tracking-[0.2em]">
              Propulsé par Mistral AI • Spécialisé en documents juridiques
            </p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-[10px] font-serif italic text-zinc-400">Ex officio</span>
            <span className="text-xs font-medium text-zinc-500">v2.0.0</span>
          </div>
          <div className="w-px h-8 bg-zinc-100" />
          <div className="bg-zinc-50 border border-zinc-100 rounded-full px-3 py-1 flex items-center gap-2">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Serveur Actif</span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column: Input */}
        <div className="space-y-8">
          <section className="bg-white rounded-2xl border border-zinc-200 shadow-[0_2px_15px_-3px_rgba(0,0,0,0.07)] overflow-hidden transition-all hover:shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            <div className="p-5 border-b border-zinc-100 bg-[#FDFCF9] flex items-center justify-between">
              <h2 className="text-sm font-serif font-bold text-zinc-900 flex items-center gap-2">
                <Upload className="w-4 h-4 text-[#D4AF37]" />
                Source du Document
              </h2>
              {files.length > 0 && (
                <button
                  onClick={reset}
                  className="text-[10px] text-zinc-400 hover:text-red-600 font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Réinitialiser
                </button>
              )}
            </div>

            <div className="p-8">
              {files.length === 0 ? (
                <div
                  {...getRootProps()}
                  className={cn(
                    "border-2 border-dashed rounded-2xl p-16 flex flex-col items-center justify-center text-center transition-all cursor-pointer",
                    isDragActive ? "border-[#D4AF37] bg-[#FDFCF9]" : "border-zinc-100 hover:border-[#D4AF37]/50 hover:bg-[#FDFCF9]/50"
                  )}
                >
                  <input {...getInputProps()} />
                  <div className="bg-zinc-50 p-5 rounded-full mb-6 shadow-inner">
                    <Upload className="w-10 h-10 text-zinc-300" />
                  </div>
                  <h3 className="text-base font-serif font-bold text-zinc-900 mb-2">
                    {isDragActive ? "Déposez le folio ici" : "Déposez un document ou cliquez pour parcourir"}
                  </h3>
                  <p className="text-xs text-zinc-400 max-w-xs leading-relaxed">
                    Images (JPG, PNG) ou PDF (jusqu'à 50 pages).<br/>
                    Optimisé pour les archives de la CPJI et Gallica.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="relative aspect-[3/4] bg-[#FDFCF9] rounded-2xl overflow-hidden border border-zinc-100 shadow-inner group">
                    {previews[0] ? (
                      <img
                        src={previews[0]}
                        alt="Preview"
                        className="w-full h-full object-contain p-4"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-zinc-300">
                        <FileText className="w-16 h-16 mb-4 opacity-20" />
                        <span className="text-xs font-serif italic">Aperçu en cours de chargement...</span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-zinc-900/80 to-transparent p-6 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0 flex justify-between items-end">
                      <p className="text-white text-xs font-medium truncate flex-1 mr-4">{files[0].name}</p>
                      {pdfPageCount > 1 && (
                        <span className="bg-[#D4AF37] text-zinc-900 text-[10px] font-bold px-3 py-1 rounded-full shadow-lg">
                          {pdfPageCount} PAGES
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={processOCR}
                    disabled={isProcessing}
                    className={cn(
                      "w-full py-4 rounded-xl font-serif font-bold text-base flex items-center justify-center gap-3 transition-all shadow-md",
                      isProcessing
                        ? "bg-zinc-100 text-zinc-400 cursor-not-allowed"
                        : "bg-zinc-900 text-white hover:bg-zinc-800 active:scale-[0.98] hover:shadow-lg"
                    )}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Analyse avec Mistral...
                      </>
                    ) : (
                      <>
                        <FileSearch className="w-5 h-5 text-[#D4AF37]" />
                        Lancer la Transcription
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </section>

          <div className="bg-zinc-900 border-l-4 border-[#D4AF37] rounded-r-2xl p-5 shadow-sm">
            <h4 className="text-xs font-bold text-[#D4AF37] uppercase tracking-widest flex items-center gap-2 mb-2">
              <ImageIcon className="w-3.5 h-3.5" />
              Note de Recherche
            </h4>
            <p className="text-xs text-zinc-300 leading-relaxed font-serif italic">
              "Pour une position optimale sur les textes juridiques anciens (1922-1946), Mistral AI surpasse Gemini
              dans la détection des caractères complexes et la structure des documents bilingues."
            </p>
          </div>

          {history.length > 0 && (
            <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
              <div className="p-4 border-b border-zinc-100 bg-zinc-50/50 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-700 flex items-center gap-2">
                  <FileSearch className="w-4 h-4" />
                  Historique Récent
                </h2>
                <button
                  onClick={clearHistory}
                  className="text-[10px] text-zinc-400 hover:text-red-500 font-medium transition-colors"
                >
                  Effacer
                </button>
              </div>
              <div className="divide-y divide-zinc-100">
                {history.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => loadFromHistory(item)}
                    className="w-full p-4 text-left hover:bg-zinc-50 transition-colors flex items-center justify-between group"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-zinc-900 truncate">{item.fileName}</p>
                      <p className="text-[10px] text-zinc-400 mt-0.5">
                        {new Date(item.timestamp).toLocaleDateString('fr-FR')} • {item.text.length} caractères
                      </p>
                      {item.metadata?.caseNumber && (
                        <p className="text-[10px] text-[#D4AF37] font-medium mt-0.5">
                          {item.metadata.caseNumber} • {item.metadata.date}
                        </p>
                      )}
                    </div>
                    <FileText className="w-4 h-4 text-zinc-300 group-hover:text-indigo-500 transition-colors shrink-0 ml-4" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right Column: Results */}
        <div className="space-y-8">
          <section className="bg-white rounded-2xl border border-zinc-200 shadow-[0_2px_15px_-3px_rgba(0,0,0,0.07)] h-full flex flex-col min-h-[700px] transition-all">
            <div className="p-5 border-b border-zinc-100 bg-[#FDFCF9] flex items-center justify-between shrink-0">
              <h2 className="text-sm font-serif font-bold text-zinc-900 flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#D4AF37]" />
                Transcription du Folio
              </h2>
              {result && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={generateCitation}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-50 rounded-lg transition-colors text-zinc-900 text-[10px] font-bold uppercase tracking-wider border border-zinc-100"
                  >
                    <FileSearch className="w-3.5 h-3.5 text-[#D4AF37]" />
                    Citer
                  </button>
                  <div className="w-px h-4 bg-zinc-200" />
                  <button
                    onClick={copyToClipboard}
                    className="p-2 hover:bg-zinc-100 rounded-lg transition-colors text-zinc-500 relative group"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={downloadText}
                    className="p-2 hover:bg-zinc-100 rounded-lg transition-colors text-zinc-500 relative group"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 p-10 overflow-y-auto relative bg-[#FDFCF9]/30">
              {showCitation && (
                <div className="mb-10 p-5 bg-zinc-900 border-l-4 border-[#D4AF37] rounded-r-xl animate-in fade-in slide-in-from-top-4 duration-500 shadow-md">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[9px] font-bold text-[#D4AF37] uppercase tracking-[0.2em]">Référence Bibliographique</span>
                    <button onClick={() => setShowCitation(false)} className="text-zinc-400 hover:text-white transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-sm font-serif italic text-zinc-100 leading-relaxed">{citation}</p>
                </div>
              )}

              {!result && !isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-300 p-12 text-center">
                  <div className="bg-zinc-50 p-8 rounded-full mb-6 shadow-inner opacity-40">
                    <FileText className="w-16 h-16" />
                  </div>
                  <p className="text-base font-serif italic text-zinc-400">Le texte transcrit apparaîtra ici...</p>
                  <p className="text-[10px] mt-4 uppercase tracking-[0.15em] font-bold opacity-30">En attente de document</p>
                </div>
              )}

              {isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/90 backdrop-blur-md z-10">
                  <div className="relative mb-6">
                    <Loader2 className="w-16 h-16 text-zinc-900 animate-spin opacity-20" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <FileSearch className="w-6 h-6 text-[#D4AF37] animate-pulse" />
                    </div>
                  </div>
                  <p className="text-lg font-serif font-bold text-zinc-900">Transcription avec Mistral OCR...</p>
                  <div className="w-full max-w-xs mt-4">
                    <div className="w-full bg-gray-200 rounded-full h-2.5">
                      <div
                        className="bg-[#D4AF37] h-2.5 rounded-full"
                        style={{ width: `${progress}%` }}
                      ></div>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-400 mt-2 font-serif italic">
                    {progress < 100 ? `Extraction en cours... (${Math.round(progress)}%)` : "Finalisation..."}
                  </p>
                </div>
              )}

              {result && (
  <>
    {/* Affichage des métadonnées si disponibles */}
    {result.metadata && (
      <div className="mb-8 p-4 bg-zinc-50 border border-zinc-200 rounded-lg shadow-inner">
        <h3 className="text-sm font-serif font-bold text-zinc-900 mb-2 flex items-center gap-2">
          <FileSearch className="w-4 h-4 text-[#D4AF37]" />
          Métadonnées Juridiques
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {result.metadata.date && (
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">Date:</span>
              <span className="font-medium text-zinc-900">{result.metadata.date}</span>
            </div>
          )}
          {result.metadata.caseNumber && (
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">Référence:</span>
              <span className="font-medium text-zinc-900">{result.metadata.caseNumber}</span>
            </div>
          )}
          {result.metadata.parties && result.metadata.parties.length > 0 && (
            <div className="flex items-center gap-1.5 col-span-1 sm:col-span-2">
              <span className="text-zinc-500">Parties:</span>
              <span className="font-medium text-zinc-900">
                {result.metadata.parties.join(" vs. ")}
              </span>
            </div>
          )}
        </div>
      </div>
    )}

    {/* Texte extrait avec des classes Tailwind pour les sauts de ligne */}
    <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none">
  <Markdown
    components={{
      p: ({ children }) => <p className="mb-4 leading-relaxed">{children}</p>,
      pre: ({ children }) => (
        <pre className="whitespace-pre-wrap break-words mb-4 bg-gray-100 p-4 rounded leading-relaxed">
          {children}
        </pre>
      ),
      // Ajouter des composants pour les titres
      h1: ({ children }) => <h1 className="text-2xl font-bold mb-4 mt-6">{children}</h1>,
      h2: ({ children }) => <h2 className="text-xl font-bold mb-3 mt-5">{children}</h2>,
      h3: ({ children }) => <h3 className="text-lg font-bold mb-2 mt-4">{children}</h3>,
      // Ajouter des composants pour les listes
      ul: ({ children }) => <ul className="list-disc pl-5 mb-4">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal pl-5 mb-4">{children}</ol>,
      li: ({ children }) => <li className="mb-2 leading-relaxed">{children}</li>,
    }}
  >
    {result.text}
  </Markdown>
</div>
  </>
)}

            </div>

            {result && (
              <div className="p-5 border-t border-zinc-100 bg-[#FDFCF9] shrink-0">
                <div className="flex items-center justify-center gap-4">
                  <div className="h-px w-12 bg-zinc-200" />
                  <p className="text-[9px] text-zinc-400 font-bold uppercase tracking-[0.2em]">
                    {result.metadata?.caseNumber ? `Fin de ${result.metadata.caseNumber}` : "Fin de la Transcription"}
                  </p>
                  <div className="h-px w-12 bg-zinc-200" />
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-[#D4AF37]/10 px-8 py-6 text-center">
        <div className="flex flex-col items-center gap-2">
          <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-[0.3em]">
            Légiscribe OCR • Laboratoire de Recherche Juridique
          </p>
          <p className="text-[10px] text-zinc-300 italic font-serif">
            Propulsé par Mistral AI • Optimisé pour les archives de la CPJI (1922-1946)
          </p>
        </div>
      </footer>
      </div>
  );
}
