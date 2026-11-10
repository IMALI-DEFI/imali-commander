import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP tools and bounded file transfer', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'imali-test-'));
 const client=new Client({name:'imali-tests',version:'1.0'});
 try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:['src/server.js'],env:{...process.env,IMALI_WORKSPACE:root,IMALI_HOME:root+'-home',IMALI_AUDIT_LOG:'off'}}));
  const tools=await client.listTools(); assert.equal(tools.tools.length,10);
  const call=async(name,args)=> (await client.callTool({name,arguments:args})).content[0].text;
  const payload=Buffer.from('IMALI transfer').toString('base64');
  assert.match(await call('upload_file',{file:'sample.txt',data:payload}),/written/);
  assert.equal(JSON.parse(await call('download_file',{file:'sample.txt'})).data,payload);
  assert.match(await call('upload_file',{file:'../escape.txt',data:payload}),/Outside allowed workspace/);
  assert.match(await call('upload_file',{file:'bad.txt',data:'%%%'}),/Invalid base64/);
  assert.match(await call('run_workspace_command',{command:'pwd'}),/exitCode/);
 } finally { await client.close(); await rm(root,{recursive:true,force:true}); }
});
