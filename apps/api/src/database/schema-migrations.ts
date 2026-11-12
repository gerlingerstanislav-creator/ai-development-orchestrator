import type {Pool} from 'pg';

export type SchemaMigration = {
 version:number;
 name:string;
 checksum:string;
 up:(database:Pool)=>Promise<void>;
};

const LOCK_KEY_1=0x41444f; // ADO
const LOCK_KEY_2=0x534348; // SCH

/**
 * Run migrations under a connection-scoped advisory lock, with one transaction
 * per version. A rollback leaves the failed version unapplied and retryable.
 *
 * Existing installations have no version ledger: the first migration must be
 * idempotent, and is applied once to both old and new databases.
 */
export async function runSchemaMigrations(pool:Pool,migrations:readonly SchemaMigration[]):Promise<number[]> {
 const ordered=[...migrations].sort((a,b)=>a.version-b.version);
 for(let i=0;i<ordered.length;i++){
  const m=ordered[i];
  if(!Number.isSafeInteger(m.version)||m.version<=0||!m.name||!m.checksum)
   throw new Error('Invalid schema migration identity');
  if(i>0&&ordered[i-1].version===m.version)throw new Error('Duplicate schema migration version '+m.version);
 }
 const client=await pool.connect();
 let locked=false;
 try{
  await client.query('SELECT pg_advisory_lock($1::int,$2::int)',[LOCK_KEY_1,LOCK_KEY_2]);
  locked=true;
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations(
   version integer PRIMARY KEY,
   name text NOT NULL,
   checksum text NOT NULL,
   applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const existing=await client.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version');
  const applied=new Map<number,{name:string;checksum:string}>(existing.rows.map(row=>[
   Number(row.version),{name:String(row.name),checksum:String(row.checksum)}
  ]));
  for(const [version,record] of applied){
   const migration=ordered.find(candidate=>candidate.version===version);
   if(!migration)throw new Error('Unknown schema migration version '+version+'; upgrade the application before startup');
   if(migration.name!==record.name||migration.checksum!==record.checksum)
    throw new Error('Schema migration integrity mismatch for version '+version);
  }
  const changed:number[]=[];
  for(const migration of ordered){
   if(applied.has(migration.version))continue;
   await client.query('BEGIN');
   try{
    // All repository bootstrap functions use query(); give them one pinned
    // transaction connection, rather than borrowing from the Pool.
    await migration.up(client as unknown as Pool);
    await client.query(
     'INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)',
     [migration.version,migration.name,migration.checksum]
    );
    await client.query('COMMIT');
    changed.push(migration.version);
   }catch(error){
    await client.query('ROLLBACK');
    throw error;
   }
  }
  return changed;
 }finally{
  try{
   if(locked)await client.query('SELECT pg_advisory_unlock($1::int,$2::int)',[LOCK_KEY_1,LOCK_KEY_2]);
  }finally{client.release();}
 }
}
