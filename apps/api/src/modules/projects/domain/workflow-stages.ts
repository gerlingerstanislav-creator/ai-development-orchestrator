import {z} from 'zod';

/** Canonical project workflow stage and transition configuration validators. */
export const validStages=z.enum([
 'backlog','analysis','development','testing','merge_queue','deployment','documentation','done'
]);
export const validMode=z.enum(['automatic','approval','manual']);
