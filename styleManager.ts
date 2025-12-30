// styleManager.ts

import { Notice } from 'obsidian';
import type OpenRouterTranslatorPlugin from './main';
 

// Constants related to styling
const LINE_HEIGHT_MIN = 0.8;
const LINE_HEIGHT_MAX = 2.0;
export const LINE_HEIGHT_STEP = 0.1;
const FONT_SIZE_MIN_PX = 6;
const FONT_SIZE_MAX_PX = 72;

/**
 * Manages all styling logic for overlays, including font size and line height.
 */
export class StyleManager {
    private plugin: OpenRouterTranslatorPlugin;

    constructor(plugin: OpenRouterTranslatorPlugin) {
        this.plugin = plugin;
        // Ensure line height is a number on initialization
        if (typeof this.plugin.settings.outputLineHeight !== 'number') {
            this.plugin.settings.outputLineHeight = 1.2;
        }
    }

    /**
     * Applies a specific line height value to an overlay's inner div.
     * @param inner The inner div element of the overlay.
     * @param value The line height value to apply.
     */
    public applyLineHeight(inner: HTMLDivElement, value: number): void {
        const lineHeightStr = `${value}`;
        inner.style.lineHeight = lineHeightStr;
        // Also set a CSS variable on the parent for potential styling hooks
        inner.parentElement?.style.setProperty('--overlay-line-height', lineHeightStr);
    }

    /**
     * Adjusts the global line height setting and applies it to all visible overlays.
     * @param delta The amount to change the line height by (e.g., 0.1 or -0.1).
     */
    public adjustGlobalLineHeight(delta: number): void {
        try {
            let newValue = (this.plugin.settings.outputLineHeight || 1.2) + delta;
            newValue = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, newValue));
            newValue = Math.round(newValue * 10) / 10; // Round to one decimal place

            this.plugin.settings.outputLineHeight = newValue;
            this.plugin.saveSettings();

            // Apply the new global line height to all reflow overlays
            document.querySelectorAll('.pdf-text-overlay-reflow div').forEach(inner => {
                this.applyLineHeight(inner as HTMLDivElement, newValue);
            });

            new Notice(`Line height set to ${newValue}`);
        } catch (error) {
            console.error('adjustGlobalLineHeight failed:', error);
            new Notice('Failed to adjust line height');
        }
    }

    /**
     * Adjusts the line height for a single, specific overlay element.
     * @param overlayEl The specific '.pdf-text-overlay-reflow' element to adjust.
     * @param delta The amount to change the line height by.
     */
    public adjustSingleOverlayLineHeight(overlayEl: HTMLElement, delta: number): void {
        const inner = overlayEl.querySelector('div');
        if (!inner) return;

        try {
            // Use the element's current style or fall back to the global setting
            const currentLineHeight = parseFloat(inner.style.lineHeight) || this.plugin.settings.outputLineHeight || 1.2;

            let newValue = currentLineHeight + delta;
            newValue = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, newValue));
            newValue = Math.round(newValue * 10) / 10;

            this.applyLineHeight(inner, newValue);
        } catch (error) {
            console.error('adjustSingleOverlayLineHeight failed:', error);
        }
    }

    /**
     * Adjusts the font size for a single, specific overlay element.
     * @param overlayEl The specific '.pdf-text-overlay-reflow' element to adjust.
     * @param scaleFactor The amount to scale the font size by (e.g., 1.1 for increase).
     */
    public adjustSingleOverlayFontSize(overlayEl: HTMLElement, scaleFactor: number): void {
        if (!overlayEl) return;

        try {
            const currentSize = parseFloat(overlayEl.style.fontSize);
            if (isNaN(currentSize)) {
                console.error('Could not parse current font size for adjustment.');
                return;
            }

            let newSize = currentSize * scaleFactor;
            newSize = Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, newSize));

            overlayEl.style.fontSize = `${newSize}px`;
        } catch (error) {
            console.error('adjustSingleOverlayFontSize failed:', error);
        }
    }

    /**
     * Attempts to make an overlay's content fit within its bounds by adjusting
     * line height and font size, falling back to a scrollbar if necessary.
     * @param el The overlay element.
     */
    public adjustOverlayForOverflow(el: HTMLElement): void {
        const inner = el.querySelector('div');
        if (!inner) return;

        // Check for overflow
        if (inner.scrollHeight <= el.clientHeight && inner.scrollWidth <= el.clientWidth) {
            return;
        }

        // Step 1: Attempt to shrink line height
        let currentLineHeight = parseFloat(inner.style.lineHeight) || this.plugin.settings.outputLineHeight || 1.2;
        while (inner.scrollHeight > el.clientHeight && currentLineHeight > 0.9) {
            currentLineHeight -= 0.05;
            this.applyLineHeight(inner, currentLineHeight);
        }

        // Step 2: Attempt to shrink font size
        let currentFontSize = parseFloat(el.style.fontSize);
        while ((inner.scrollHeight > el.clientHeight || inner.scrollWidth > el.clientWidth) && currentFontSize > 8) {
            currentFontSize *= 0.99;
            el.style.fontSize = `${currentFontSize}px`;
        }

        // Step 3: Add scrollbar as a last resort
        if (inner.scrollHeight > el.clientHeight || inner.scrollWidth > el.clientWidth) {
            el.style.overflow = 'auto';
        }
    }

    /**
     * Calculates the initial font size for an overlay based on original text attributes.
     * @param originalFontSizes An array of font sizes from the original PDF text.
     * @param referenceSpan A reference span from the PDF's text layer.
     * @param currentScale The current zoom scale of the PDF viewer.
     * @returns The calculated font size in pixels.
     */
    public calculateInitialFontSize(originalFontSizes: number[], referenceSpan: HTMLSpanElement, currentScale: number): number {
        const avgOriginalFontSize = originalFontSizes.length > 0
            ? originalFontSizes.reduce((a, b) => a + b, 0) / originalFontSizes.length
            : parseFloat(window.getComputedStyle(referenceSpan).fontSize) || 12;

        const baseFontSize = avgOriginalFontSize * this.plugin.settings.outputFontSizeScale;
        return baseFontSize * currentScale;
    }
}