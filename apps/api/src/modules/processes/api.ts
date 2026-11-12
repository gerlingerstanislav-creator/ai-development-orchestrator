import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {listBackgroundProcesses} from './application/background-processes.js';

/** HTTP adapts the authenticated user to a read-only process-center query. */
export function registerBackgroundProcessRoutes(app:FastifyInstance,pool:Pick<Pool,'query'>,uid:(req:any)=>string){
 app.get('/api/background-processes',async(req:any)=>listBackgroundProcesses(pool,uid(req)));
}
