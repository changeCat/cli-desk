import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version')) { console.log('Claude Code protocol fixture'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const session_id = '11111111-1111-4111-8111-111111111111';
const rl = readline.createInterface({ input:process.stdin });
rl.on('line',line=>{
  const m=JSON.parse(line);
  if(m.type==='control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[],account:{},output_style:'default',available_output_styles:[]}}});
  } else if(m.type==='user') {
    send({type:'system',subtype:'init',session_id,uuid:randomUUID(),tools:['Write'],cwd:process.cwd(),model:'fixture',permissionMode:'default',apiKeySource:'none',mcp_servers:[],slash_commands:[],claude_code_version:'fixture'});
    send({type:'stream_event',session_id,uuid:randomUUID(),parent_tool_use_id:null,event:{type:'message_start',message:{id:'fixture-message',type:'message',role:'assistant',content:[],model:'fixture',usage:{input_tokens:0,output_tokens:0}}}});
    send({type:'stream_event',session_id,uuid:randomUUID(),parent_tool_use_id:null,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'真实 SDK 协议测试'}}});
    send({type:'control_request',request_id:'permission-1',request:{subtype:'can_use_tool',tool_name:'Write',input:{file_path:'test.txt',content:'fixture'},tool_use_id:'tool-1',permission_suggestions:[]}});
  } else if(m.type==='control_response' && m.response.request_id==='permission-1') {
    send({type:'assistant',session_id,uuid:randomUUID(),parent_tool_use_id:null,message:{id:'fixture-message',type:'message',role:'assistant',model:'fixture',content:[{type:'text',text:'真实 SDK 协议测试'}],usage:{input_tokens:1,output_tokens:1},stop_reason:'end_turn'}});
    send({type:'result',subtype:'success',is_error:false,result:'真实 SDK 协议测试',session_id,uuid:randomUUID(),duration_ms:50,duration_api_ms:50,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{},permission_denials:[]});
  }
});
rl.on('close',()=>process.exit(0));
