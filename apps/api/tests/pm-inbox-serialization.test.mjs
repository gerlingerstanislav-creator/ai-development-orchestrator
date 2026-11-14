import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {deliverProjectManagerInbox} from '../dist/project-manager-inbox.js';

test('project PM messages are dispatched FIFO; processing and pending older turns hold newer ones',async t=>{
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});
 await client.connect();
 const schema='pmfifo_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public'});
 t.after(async()=>{await pool.end();await client.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await client.end();});
 await client.query('CREATE SCHEMA '+schema);
 await client.query('SET search_path TO '+schema+',public');
 await client.query(`CREATE TABLE assistant_messages (
  id uuid PRIMARY KEY,project_id uuid NOT NULL,role text,channel text,status text,
  pm_dispatch_attempt integer DEFAULT 1,pm_order_id uuid,pm_dispatched_at timestamptz,
  pm_next_dispatch_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
 );`);
 const project=randomUUID(),other=randomUUID(),first=randomUUID(),second=randomUUID(),third=randomUUID();
 const write=(id,p,delay)=>client.query(`INSERT INTO assistant_messages
  (id,project_id,role,channel,status,created_at) VALUES($1,$2,'user','project','queued',now()+($3||' seconds')::interval)`,
  [id,p,delay]);
 await write(first,project,'-3');
 await write(second,project,'-2');
 await write(third,other,'-1');
 const launched=[];
 const run=async turn=>{launched.push(turn.id);};
 const failed=()=>assert.fail('No PM dispatch failures expected');
 await deliverProjectManagerInbox(pool,run,failed);
 assert.deepEqual(new Set(launched),new Set([first,third]),'independent projects are parallel; same-project turns are ordered');
 await client.query("UPDATE assistant_messages SET status='processing' WHERE id=$1",[first]);
 await deliverProjectManagerInbox(pool,run,failed);
 assert.equal(launched.includes(second),false,'second turn waits while first is processing');
 await client.query("UPDATE assistant_messages SET status='completed' WHERE id=$1",[first]);
 await deliverProjectManagerInbox(pool,run,failed);
 assert.equal(launched.filter(id=>id===second).length,1,'second resumes after first becomes terminal');
});
