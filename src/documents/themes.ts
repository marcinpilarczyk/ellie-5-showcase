import { ThemeName } from './blocks.js';

/** A font family the theme uses, with the bundled files (assets/fonts) to embed for each face. */
export interface ThemeFont {
  family: string;
  regular?: string;
  bold?: string;
  italic?: string;
  boldItalic?: string;
}

/** A text style: sizes in points, colours as hex without '#'. */
export interface TextStyle {
  font: 'sans' | 'serif';
  sizePt: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  allCaps?: boolean;
  letterSpacingPt?: number;
}

export interface Theme {
  name: ThemeName;
  /** A4 in millimetres. */
  page: { widthMm: number; heightMm: number; marginTopMm: number; marginBottomMm: number; marginSideMm: number };
  fonts: { sans: ThemeFont; serif: ThemeFont };
  /** Line height as a multiple of the font size. */
  lineSpacing: number;
  personName: TextStyle;
  headline: TextStyle;
  contact: TextStyle;
  heading: TextStyle & { ruleColor: string; rulePt: number; spaceBeforePt: number; spaceAfterPt: number };
  body: TextStyle & { spaceAfterPt: number };
  bullet: { indentPt: number; hangingPt: number; spaceAfterPt: number; glyph: string };
  roleTitle: TextStyle & { spaceBeforePt: number };
  roleEmployer: TextStyle;
  roleMeta: TextStyle;
  roleContext: TextStyle;
  note: TextStyle & { spaceBeforePt: number };
}

const ACCENT = '17324D';
const INK = '222222';
const MUTED = '555555';

/**
 * executive-editorial: one column, A4, serif name and section headings over a sans body, one accent colour,
 * no tables, text boxes, icons or images. Sizes, colours and rules measured from the owner's reference resume.
 */
export const EXECUTIVE_EDITORIAL: Theme = {
  name: 'executive-editorial',
  page: { widthMm: 210, heightMm: 297, marginTopMm: 17, marginBottomMm: 17, marginSideMm: 18 },
  fonts: {
    sans: {
      family: 'Google Sans Text',
      regular: 'GoogleSansText-Regular.ttf',
      bold: 'GoogleSansText-Bold.ttf',
      italic: 'GoogleSansText-Italic.ttf',
      boldItalic: 'GoogleSansText-BoldItalic.ttf'
    },
    serif: { family: 'Merriweather', regular: 'Merriweather-Regular.ttf', bold: 'Merriweather-Bold.ttf' }
  },
  lineSpacing: 1.15,
  personName: { font: 'serif', sizePt: 22, color: ACCENT, bold: true, allCaps: true },
  headline: { font: 'sans', sizePt: 11, color: INK, bold: true },
  contact: { font: 'sans', sizePt: 10.5, color: MUTED },
  heading: {
    font: 'serif', sizePt: 10.5, color: ACCENT, bold: true, allCaps: true, letterSpacingPt: 1.5,
    ruleColor: ACCENT, rulePt: 0.75, spaceBeforePt: 12, spaceAfterPt: 5
  },
  body: { font: 'sans', sizePt: 10.5, color: INK, spaceAfterPt: 4 },
  bullet: { indentPt: 15, hangingPt: 9, spaceAfterPt: 2, glyph: '•' },
  roleTitle: { font: 'sans', sizePt: 10.5, color: ACCENT, bold: true, spaceBeforePt: 6 },
  roleEmployer: { font: 'sans', sizePt: 10.5, color: INK, bold: true },
  roleMeta: { font: 'sans', sizePt: 10.5, color: MUTED },
  roleContext: { font: 'sans', sizePt: 10.5, color: MUTED, italic: true },
  note: { font: 'sans', sizePt: 8, color: '777777', spaceBeforePt: 6 }
};

export const THEMES: Record<ThemeName, Theme> = {
  'executive-editorial': EXECUTIVE_EDITORIAL
};

export interface ThemeFitPreset {
  id: string;
  direction: 'tighter' | 'looser';
  theme: Theme;
}

/**
 * Deterministic micro-typesetting presets (elastic margins 14mm–19mm, lineSpacing 1.08–1.20,
 * bullet.spaceAfterPt 1.5–3pt, heading.spaceBeforePt 9–14pt) tried before failing a page-count check.
 */
export function getAutoFitPresets(base: Theme, direction: 'tighter' | 'looser'): ThemeFitPreset[] {
  if (direction === 'tighter') {
    return [
      {
        id: 'compact-1',
        direction: 'tighter',
        theme: {
          ...base,
          page: { ...base.page, marginTopMm: 15.5, marginBottomMm: 15.5, marginSideMm: 16.5 },
          lineSpacing: 1.12,
          heading: { ...base.heading, spaceBeforePt: 10.5, spaceAfterPt: 4 },
          body: { ...base.body, spaceAfterPt: 3.5 },
          bullet: { ...base.bullet, spaceAfterPt: 1.75 },
          roleTitle: { ...base.roleTitle, spaceBeforePt: 5 }
        }
      },
      {
        id: 'compact-2',
        direction: 'tighter',
        theme: {
          ...base,
          page: { ...base.page, marginTopMm: 14.5, marginBottomMm: 14.5, marginSideMm: 15.5 },
          lineSpacing: 1.10,
          heading: { ...base.heading, spaceBeforePt: 9.5, spaceAfterPt: 3.5 },
          body: { ...base.body, spaceAfterPt: 3 },
          bullet: { ...base.bullet, spaceAfterPt: 1.5 },
          roleTitle: { ...base.roleTitle, spaceBeforePt: 4.5 }
        }
      },
      {
        id: 'compact-3',
        direction: 'tighter',
        theme: {
          ...base,
          page: { ...base.page, marginTopMm: 14, marginBottomMm: 14, marginSideMm: 14 },
          lineSpacing: 1.08,
          heading: { ...base.heading, spaceBeforePt: 9, spaceAfterPt: 3 },
          body: { ...base.body, spaceAfterPt: 2.5 },
          bullet: { ...base.bullet, spaceAfterPt: 1.5 },
          roleTitle: { ...base.roleTitle, spaceBeforePt: 4 }
        }
      }
    ];
  }

  return [
    {
      id: 'spacious-1',
      direction: 'looser',
      theme: {
        ...base,
        page: { ...base.page, marginTopMm: 18, marginBottomMm: 18, marginSideMm: 18.5 },
        lineSpacing: 1.18,
        heading: { ...base.heading, spaceBeforePt: 13, spaceAfterPt: 5.5 },
        body: { ...base.body, spaceAfterPt: 4.5 },
        bullet: { ...base.bullet, spaceAfterPt: 2.5 },
        roleTitle: { ...base.roleTitle, spaceBeforePt: 7 }
      }
    },
    {
      id: 'spacious-2',
      direction: 'looser',
      theme: {
        ...base,
        page: { ...base.page, marginTopMm: 19, marginBottomMm: 19, marginSideMm: 19 },
        lineSpacing: 1.20,
        heading: { ...base.heading, spaceBeforePt: 14, spaceAfterPt: 6 },
        body: { ...base.body, spaceAfterPt: 5 },
        bullet: { ...base.bullet, spaceAfterPt: 3 },
        roleTitle: { ...base.roleTitle, spaceBeforePt: 8 }
      }
    }
  ];
}

