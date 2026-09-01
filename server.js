import express from 'express';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-campusbite-secret';
if (!DATABASE_URL) console.warn('DATABASE_URL is not set. The server cannot use PostgreSQL until it is configured.');
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false }) : null;
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const shops = ['Hari Sandwich','Reo Store','Campus Café'];
const statusNames = ['Received','Preparing','Ready','Completed'];

async function db(){ if(!pool) throw new Error('DATABASE_URL is not configured'); return pool; }
async function init(){
  if(!pool) return;
  // Ensure the complete database schema exists before running migrations/seeding.
  // This is important for fresh Render/Supabase databases where menu_items and
  // the other tables do not exist yet.
  await pool.query(schema);
  // Backward-compatible inventory migration for existing databases.
  await pool.query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stock INTEGER`);
  // Registered accounts are persistent. Remove ONLY the two legacy demo customer
  // accounts once, then permanently mark that migration as complete. No account
  // cleanup runs on subsequent server restarts, and staff accounts are untouched.
  await pool.query(`CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const legacyMigration = await pool.query(`SELECT 1 FROM app_migrations WHERE name='remove_legacy_demo_customers_v1'`);
  if (!legacyMigration.rowCount) {
    await pool.query(`DELETE FROM customers WHERE customer_code IN ('CB2026001','CB2026002')`);
    await pool.query(`INSERT INTO app_migrations(name) VALUES('remove_legacy_demo_customers_v1') ON CONFLICT DO NOTHING`);
  }

  const menu=[
    [101,'Hari Sandwich','Chicken Sandwich',75,18],[102,'Hari Sandwich','Veg Club Sandwich',65,16],[103,'Hari Sandwich','Paneer Wrap',80,14],[104,'Hari Sandwich','Cheese Toastie',55,20],
    [201,'Reo Store','Lays Classic',30,30],[202,'Reo Store','French Fries',25,25],[203,'Reo Store','Cold Cola',40,22],[204,'Reo Store','Mango Drink',35,18],
    [301,'Campus Café','Cappuccino',75,14],[302,'Campus Café','Masala Chai',30,24],[303,'Campus Café','Veg Hakka Noodles',90,15],[304,'Campus Café','Chocolate Muffin',55,17]
  ];
  for(const [id,shop,name,price,stock] of menu) {
    await pool.query(`INSERT INTO menu_items(id,shop,name,price,stock) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET shop=EXCLUDED.shop,name=EXCLUDED.name,price=EXCLUDED.price`,[id,shop,name,price,stock]);
    await pool.query(`UPDATE menu_items SET stock=$1 WHERE id=$2 AND stock IS NULL`,[stock,id]);
  }

}
function tokenFor(payload){return jwt.sign(payload,JWT_SECRET,{expiresIn:'12h'});}
function auth(req,res,next){
  try{
    const h=req.headers.authorization||''; const t=h.startsWith('Bearer ')?h.slice(7):'';
    req.user=jwt.verify(t,JWT_SECRET); next();
  }catch{res.status(401).json({error:'Unauthorized'});}
}
function role(r){return (req,res,next)=>{if(req.user?.role!==r)return res.status(403).json({error:'Forbidden'});next();};}
function serializeOrder(r){return {id:r.public_id,items:r.items,total:Number(r.total),status:Number(r.status),discount:Number(r.discount),slot:r.slot,shop:r.shop,createdAt:new Date(r.created_at).getTime(),prepStartedAt:r.prep_started_at?new Date(r.prep_started_at).getTime():null,readyAt:r.ready_at?new Date(r.ready_at).getTime():null,completedAt:r.completed_at?new Date(r.completed_at).getTime():null,customerName:r.customer_name||null,customerCode:r.customer_code||null};}
function serializeTx(r){return {icon:r.icon,title:r.title,sub:r.sub,amt:Number(r.amount),type:r.type,createdAt:new Date(r.created_at).getTime()};}

let dbReady = false;
app.get('/api/health',(req,res)=>{
  res.status(dbReady?200:200).json({
    ok:true,
    service:'CampusBite',
    database:dbReady?'ready':'initializing',
    time:new Date().toISOString()
  });
});
app.post('/api/auth/customer',async(req,res)=>{
  try{
    const {customerCode,password}=req.body;
    const r=(await (await db()).query('SELECT * FROM customers WHERE customer_code=$1',[String(customerCode||'').trim()])).rows[0];
    if(!r || !(await bcrypt.compare(String(password||''),r.password_hash))) return res.status(401).json({error:'Invalid customer ID or password'});
    const token=tokenFor({role:'customer',id:r.id,customerCode:r.customer_code});
    res.json({token,user:{role:'customer',name:r.name,customerCode:r.customer_code,year:r.year,accountType:r.account_type||'Student'}});
  }catch(e){console.error(e);res.status(500).json({error:'Login unavailable'});}
});
app.post('/api/auth/customer/signup',async(req,res)=>{
  try{
    const {name,customerCode,password,accountType}=req.body;
    const n=String(name||'').trim(), code=String(customerCode||'').trim(), pw=String(password||'');
    const type=['Student','Teacher'].includes(accountType)?accountType:'Student';
    if(n.length<2)return res.status(400).json({error:'Enter your full name'});
    if(!/^[A-Za-z0-9_-]{4,20}$/.test(code))return res.status(400).json({error:'Customer ID must be 4–20 characters'});
    if(pw.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});
    const exists=(await (await db()).query('SELECT 1 FROM customers WHERE customer_code=$1',[code])).rows[0];
    if(exists)return res.status(409).json({error:'That Customer ID is already registered'});
    const hash=await bcrypt.hash(pw,10);
    const r=(await (await db()).query(`INSERT INTO customers(customer_code,name,year,account_type,password_hash) VALUES($1,$2,'', $3,$4) RETURNING id,customer_code,name,year,account_type`,[code,n,type,hash])).rows[0];
    const token=tokenFor({role:'customer',id:r.id,customerCode:r.customer_code});
    res.status(201).json({token,user:{role:'customer',name:r.name,customerCode:r.customer_code,year:r.year,accountType:r.account_type}});
  }catch(e){console.error(e);res.status(500).json({error:'Sign up unavailable'});}
});
app.post('/api/auth/staff',async(req,res)=>{
  try{
    const {shop,pin,name,staffCode}=req.body;
    let r;
    if(staffCode){r=(await (await db()).query('SELECT * FROM staff_users WHERE staff_code=$1',[String(staffCode).trim()])).rows[0];}
    else if(shops.includes(shop)){r=(await (await db()).query('SELECT * FROM staff_users WHERE shop=$1 ORDER BY id LIMIT 1',[shop])).rows[0];}
    if(!r || !(await bcrypt.compare(String(pin||''),r.pin_hash))) return res.status(401).json({error:'Invalid staff ID or PIN'});
    if(shop && r.shop!==shop)return res.status(401).json({error:'Staff account does not belong to this shop'});
    const token=tokenFor({role:'staff',id:r.id,shop:r.shop});
    res.json({token,user:{role:'staff',name:r.name,shop:r.shop,staffCode:r.staff_code}});
  }catch(e){console.error(e);res.status(500).json({error:'Staff login unavailable'});}
});
app.post('/api/auth/staff/signup',async(req,res)=>{
  try{
    const {name,shop,pin,staffCode}=req.body;
    const n=String(name||'').trim(), code=String(staffCode||'').trim(), p=String(pin||'');
    const type='Staff';
    if(n.length<2)return res.status(400).json({error:'Enter your full name'});
    if(!shops.includes(shop))return res.status(400).json({error:'Select a valid shop'});
    if(!/^[A-Za-z0-9_-]{4,20}$/.test(code))return res.status(400).json({error:'Staff ID must be 4–20 characters'});
    if(!/^\d{4,6}$/.test(p))return res.status(400).json({error:'PIN must be 4–6 digits'});
    const exists=(await (await db()).query('SELECT 1 FROM staff_users WHERE staff_code=$1',[code])).rows[0];
    if(exists)return res.status(409).json({error:'That Staff ID is already registered'});
    const hash=await bcrypt.hash(p,10);
    const r=(await (await db()).query(`INSERT INTO staff_users(name,shop,staff_code,account_type,pin_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,name,shop,staff_code,account_type`,[n,shop,code,type,hash])).rows[0];
    const token=tokenFor({role:'staff',id:r.id,shop:r.shop});
    res.status(201).json({token,user:{role:'staff',name:r.name,shop:r.shop,staffCode:r.staff_code}});
  }catch(e){console.error(e);res.status(500).json({error:'Staff sign up unavailable'});}
});

app.get('/api/customer/state',auth,role('customer'),async(req,res)=>{
  try{const d=await db(); const s=(await d.query('SELECT * FROM customers WHERE id=$1',[req.user.id])).rows[0]; if(!s)return res.status(404).json({error:'Customer not found'});
    const os=(await d.query('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',[s.id])).rows;
    const tx=(await d.query('SELECT * FROM wallet_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[s.id])).rows;
    res.json({wallet:Number(s.wallet_balance),cashback:Number(s.cashback),autopay:{enabled:s.autopay_enabled,threshold:Number(s.autopay_threshold),amount:Number(s.autopay_amount)},orders:os.map(serializeOrder),transactions:tx.map(serializeTx)});
  }catch(e){console.error(e);res.status(500).json({error:'State unavailable'});}
});

app.post('/api/customer/order',auth,role('customer'),async(req,res)=>{
  const client=await (await db()).connect();
  try{
    const {items,slot,shop}=req.body;
    const allowedPickupSlots=new Set([
      'ASAP',
      '9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','11:30 AM',
      '12:00 PM','12:30 PM','1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM'
    ]);
    if(!shops.includes(shop)||!Array.isArray(items)||!items.length||!allowedPickupSlots.has(String(slot||'')))
      return res.status(400).json({error:'Please select a valid pickup time'});
    const normalized=items.map(i=>({id:Number(i.id),q:Number(i.q),name:String(i.name||''),emoji:String(i.emoji||'🍱')}));
    if(normalized.some(i=>!Number.isInteger(i.id)||!Number.isInteger(i.q)||i.q<1||i.q>20)) return res.status(400).json({error:'Invalid quantity'});
    const quantities=new Map();
    for(const i of normalized) quantities.set(i.id,(quantities.get(i.id)||0)+i.q);
    if([...quantities.values()].some(q=>q>20)) return res.status(400).json({error:'Invalid quantity'});
    await client.query('BEGIN');
    const s=(await client.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
    if(!s) throw new Error('Customer not found');
    const ids=[...new Set(normalized.map(i=>i.id))];
    const menuRows=(await client.query('SELECT id,shop,name,price,stock,available FROM menu_items WHERE id=ANY($1::int[]) FOR UPDATE',[ids])).rows;
    if(menuRows.length!==ids.length){ await client.query('ROLLBACK'); return res.status(400).json({error:'One or more menu items are unavailable'}); }
    const byId=new Map(menuRows.map(r=>[Number(r.id),r]));
    if(normalized.some(i=>{const m=byId.get(i.id);return !m||m.shop!==shop||!m.available})){ await client.query('ROLLBACK'); return res.status(400).json({error:'One or more selected items are unavailable'}); }
    if([...quantities.entries()].some(([id,q])=>Number(byId.get(id)?.stock ?? 0) < q)){
      await client.query('ROLLBACK');
      return res.status(400).json({error:'One or more selected items do not have enough stock'});
    }
    const calculatedSubtotal=normalized.reduce((sum,i)=>sum+Number(byId.get(i.id).price||0)*i.q,0);
    if(calculatedSubtotal<=0){ await client.query('ROLLBACK'); return res.status(400).json({error:'Invalid menu pricing'}); }
    // CAMPUS10 is a genuine first-order offer: eligibility is determined
    // server-side from the customer's order history, never from the browser.
    const priorOrders=Number((await client.query('SELECT COUNT(*)::int AS count FROM orders WHERE customer_id=$1',[s.id])).rows[0].count||0);
    const discount=priorOrders===0 && Number(req.body.discount)>0 && calculatedSubtotal>=100
      ? Math.round(calculatedSubtotal*0.10)
      : 0;
    const fee=3;
    const payable=calculatedSubtotal-discount+fee;
    if(Number(s.wallet_balance)<payable){ await client.query('ROLLBACK'); return res.status(400).json({error:'Insufficient wallet balance',balance:Number(s.wallet_balance)}); }
    const publicId='CB-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,7).toUpperCase();
    const storedItems=normalized.map(i=>({id:i.id,name:byId.get(i.id).name,price:Number(byId.get(i.id).price),q:i.q,emoji:i.emoji}));
    for(const [id,q] of quantities){
      await client.query('UPDATE menu_items SET stock=GREATEST(0,COALESCE(stock,0)-$1) WHERE id=$2',[q,id]);
    }
    await client.query('UPDATE customers SET wallet_balance=wallet_balance-$1 WHERE id=$2',[payable,s.id]);
    const row=(await client.query(`INSERT INTO orders(public_id,customer_id,shop,items,total,discount,slot) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[publicId,s.id,shop,JSON.stringify(storedItems),payable,discount,slot||'ASAP'])).rows[0];
    await client.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type) VALUES($1,'🍱','CampusBite order',$2,$3,'debit')`,[s.id,`${storedItems.length} menu item${storedItems.length>1?'s':''}`,payable]);
    let balance=Number(s.wallet_balance)-payable;
    const ns=(await client.query('SELECT * FROM customers WHERE id=$1',[s.id])).rows[0];
    if(ns.autopay_enabled && balance<=Number(ns.autopay_threshold)){
      const amount=Number(ns.autopay_amount); balance+=amount;
      await client.query('UPDATE customers SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,s.id]);
      await client.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type) VALUES($1,'🔄','Auto-pay top-up',$2,$3,'credit')`,[s.id,`Automatic refill • threshold ₹${Number(ns.autopay_threshold)}`,amount]);
    }
    await client.query('COMMIT');
    res.json({order:serializeOrder(row),wallet:balance});
  }catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Could not place order'});}finally{client.release();}
});

app.post('/api/customer/wallet/topup',auth,role('customer'),async(req,res)=>{try{const d=await db(),amount=Number(req.body.amount);if(![250,500,1000,2000].includes(amount))return res.status(400).json({error:'Invalid amount'});await d.query('UPDATE customers SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,req.user.id]);await d.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type) VALUES($1,'💰','Wallet top-up','Demo wallet load',$2,'credit')`,[req.user.id,amount]);const s=(await d.query('SELECT wallet_balance FROM customers WHERE id=$1',[req.user.id])).rows[0];res.json({wallet:Number(s.wallet_balance)});}catch(e){console.error(e);res.status(500).json({error:'Top-up failed'});}});
app.post('/api/customer/autopay',auth,role('customer'),async(req,res)=>{const client=await (await db()).connect();try{const enabled=!!req.body.enabled,threshold=Number(req.body.threshold)||200,amount=Number(req.body.amount)||500;await client.query('BEGIN');const s=(await client.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];if(!s)throw new Error('Customer not found');await client.query('UPDATE customers SET autopay_enabled=$1,autopay_threshold=$2,autopay_amount=$3 WHERE id=$4',[enabled,threshold,amount,req.user.id]);let balance=Number(s.wallet_balance);if(enabled && balance<=threshold){balance+=amount;await client.query('UPDATE customers SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,req.user.id]);await client.query(`INSERT INTO wallet_transactions(customer_id,icon,title,sub,amount,type) VALUES($1,'🔄','Auto-pay top-up',$2,$3,'credit')`,[req.user.id,`Automatic refill • threshold ₹${threshold}`,amount]);}await client.query('COMMIT');res.json({autopay:{enabled,threshold,amount},wallet:balance});}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Auto-pay update failed'});}finally{client.release();}});


app.get('/api/canteen/status',async(req,res)=>{
  try{
    const d=await db();
    const shop=String(req.query.shop||'');
    if(!shops.includes(shop)) return res.status(400).json({error:'Invalid shop'});
    const activeRows=(await d.query(
      `SELECT status, created_at, prep_started_at FROM orders WHERE shop=$1 AND status < 3 ORDER BY created_at ASC`,[shop]
    )).rows;
    const history=(await d.query(
      `SELECT EXTRACT(EPOCH FROM (ready_at - COALESCE(prep_started_at, created_at)))/60 AS prep_minutes
       FROM orders WHERE shop=$1 AND status >= 2 AND ready_at IS NOT NULL
       ORDER BY ready_at DESC LIMIT 50`,[shop]
    )).rows.map(r=>Number(r.prep_minutes)).filter(n=>Number.isFinite(n)&&n>0);
    const fallback=5;
    const avgPrep=history.length ? history.reduce((a,b)=>a+b,0)/history.length : fallback;
    const activeCount=activeRows.length;
    const preparingCount=activeRows.filter(r=>Number(r.status)===1).length;

    // Estimate this shop's current wait from its own live queue.
    // No active orders means there is effectively no queue; otherwise each
    // order contributes an estimated amount of remaining preparation time.
    let estimatedMinutes=0;
    if(activeCount>0){
      const now=Date.now();
      for(const order of activeRows){
        const status=Number(order.status);
        if(status===0){
          estimatedMinutes += avgPrep;
        }else if(status===1){
          const started=order.prep_started_at ? new Date(order.prep_started_at).getTime() : now;
          const elapsed=Math.max(0,(now-started)/60000);
          estimatedMinutes += Math.max(1,avgPrep-elapsed);
        }else if(status===2){
          estimatedMinutes += 1;
        }
      }
    }
    const wait=activeCount===0 ? 2 : Math.max(2,Math.min(45,Math.ceil(estimatedMinutes)));
    res.json({shop,waitMinutes:wait,activeOrders:activeCount,preparingOrders:preparingCount,sampleSize:history.length});
  }catch(e){console.error(e);res.status(500).json({error:'Canteen status unavailable'});}
});
app.get('/api/menu',async(req,res)=>{try{const d=await db();const rows=(await d.query('SELECT id,shop,name,price,stock,available FROM menu_items ORDER BY id')).rows;res.json({items:rows});}catch(e){console.error(e);res.status(500).json({error:'Menu unavailable'});}});
app.patch('/api/staff/menu/:id',auth,role('staff'),async(req,res)=>{
  try{
    const d=await db();
    const id=Number(req.params.id);
    if(!Number.isInteger(id)) return res.status(400).json({error:'Invalid menu item'});
    const row=(await d.query('SELECT * FROM menu_items WHERE id=$1',[id])).rows[0];
    if(!row) return res.status(404).json({error:'Menu item not found'});
    const canonicalShop=id>=100&&id<200?'Hari Sandwich':id>=200&&id<300?'Reo Store':id>=300&&id<400?'Campus Café':null;
    const sameShop=canonicalShop && (
      row.shop===req.user.shop ||
      row.shop.replace('é','e').toLowerCase()===String(req.user.shop).replace('é','e').toLowerCase()
    );
    if(!sameShop || canonicalShop!==req.user.shop) return res.status(403).json({error:'You cannot change another shop\'s menu'});
    const out=(await d.query(
      'UPDATE menu_items SET available=$1 WHERE id=$2 RETURNING id,shop,name,available',
      [!!req.body.available,row.id]
    )).rows[0];
    res.json({item:out});
  }catch(e){
    console.error(e);
    res.status(500).json({error:'Availability update failed'});
  }
});

app.get('/api/staff/orders',auth,role('staff'),async(req,res)=>{try{const d=await db();const rows=(await d.query(`SELECT o.*, s.name AS customer_name, s.customer_code FROM orders o JOIN customers s ON s.id=o.customer_id WHERE o.shop=$1 ORDER BY o.created_at DESC LIMIT 500`,[req.user.shop])).rows;res.json({orders:rows.map(serializeOrder)});}catch(e){console.error(e);res.status(500).json({error:'Orders unavailable'});}});
app.patch('/api/staff/orders/:id/status',auth,role('staff'),async(req,res)=>{try{const d=await db();const row=(await d.query('SELECT * FROM orders WHERE public_id=$1 AND shop=$2',[req.params.id,req.user.shop])).rows[0];if(!row)return res.status(404).json({error:'Order not found'});if(Number(row.status)>=3)return res.status(400).json({error:'Order is already completed'});const next=Number(row.status)+1;if(next!==Number(req.body.status))return res.status(400).json({error:'Invalid next status'});let sql='UPDATE orders SET status=$1';const vals=[next,row.id];if(next===1)sql+=', prep_started_at=COALESCE(prep_started_at,NOW())';if(next===2)sql+=', ready_at=COALESCE(ready_at,NOW())';if(next===3)sql+=', completed_at=COALESCE(completed_at,NOW())';sql+=' WHERE id=$2 RETURNING *';const out=(await d.query(sql,vals)).rows[0];res.json({order:serializeOrder(out)});}catch(e){console.error(e);res.status(500).json({error:'Status update failed'});}});
app.get('/api/staff/summary',auth,role('staff'),async(req,res)=>{try{const d=await db();const day=req.query.date||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const rows=(await d.query(`SELECT * FROM orders WHERE shop=$1 AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`,[req.user.shop,day])).rows;const revenue=rows.reduce((a,r)=>a+Number(r.total),0);const active=rows.filter(r=>r.status<3).length;res.json({date:day,orders:rows.length,revenue,active});}catch(e){console.error(e);res.status(500).json({error:'Summary unavailable'});}});

app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// Start HTTP immediately so Render can reach the service even while PostgreSQL
// is waking up or the first-time schema initialization is running.
const server = app.listen(PORT,'0.0.0.0',()=>{
  console.log(`CampusBite listening on ${PORT}`);
  init()
    .then(()=>{ dbReady=true; console.log('CampusBite database initialization complete'); })
    .catch(e=>console.error('CampusBite database initialization failed:',e));
});

process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
