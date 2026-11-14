export type ParseProgressStage = 'pdf_rendering' | 'vision_extraction';

export type ParseProgressEvent = {
  stage: ParseProgressStage;
  status: 'in_progress' | 'completed';
  completedUnits: number;
  totalUnits: number;
  unit: 'pages';
};

export type ParseProgressCallback = (event: ParseProgressEvent) => Promise<void> | void;
