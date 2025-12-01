//configs
type parametersKey = "COMPANY_ID" | "CONTACT_ID" | "TABLE_NAME" | "STATUS";

import { getDatabase, Reference  } from "firebase-admin/database";
import { initializeApp, cert} from 'firebase-admin/app';
const serviceAccount :any= require('./../ucl-pms-project-firebase-c6b10789f613.json');

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import moment from 'moment-timezone';

const strUiPathAPITransactions = "UiPathAPITransactions";

const databaseURL = {value:()=>process.env.DATABASE_URL!};

const app = initializeApp({
    credential: cert(serviceAccount),
    databaseURL: databaseURL.value()
});
const database = getDatabase(app);
const ServerInstanceDatabase = database.ref("/"+process.env.SERVER_INSTANCE_DATABASE||"test");
const CallUipathAPITransactionQueue: Reference = ServerInstanceDatabase.child(strUiPathAPITransactions);
const transactionState = {new:"new",process:"process",failed:"failed",successful:"successful",pending:"pending",finalize:"finalize",takeover:"takeover"};
const AUTH_TOKEN = process.env.PORTAL_API_TOKEN || "change_this_secret_token";
const PORT = process.env.PORTAL_PORT ? Number(process.env.PORTAL_PORT) : 8787;

const appServer = express();
appServer.use(bodyParser.json());
//Middleware สำหรับตรวจสอบ Authorization
appServer.use((req, res, next) => {
  const authHeader = req.headers["authorization"];

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  if (token !== AUTH_TOKEN) {
    return res.status(403).json({ error: "Forbidden: invalid token" });
  }

  next(); // ผ่านการตรวจสอบ
});

//Health Check Endpoint
appServer.get("/health", (req, res) => {
  console.log("pinged",req.ip);  
  const params = checkValidParameter(req.headers);
  if (!params) {
    return res.status(400).json({ error: "Missing or invalid required headers." });
  }
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    ...params
  });

});

appServer.post("/Sync", async (req, res) => {
  try {
    // ดึงค่า COMPANY_ID จาก header

    const params = checkValidParameter(req.headers);
    if (!params) {
      return res.status(400).json({ error: "Missing or invalid required headers." });
    }
    const companyId:string = params["COMPANY_ID"];
    const contactId:string = params["CONTACT_ID"];
    // สร้าง eventID แบบ unique
    const eventID = `${companyId??''}${contactId??''}${crypto.randomUUID()}`;

    // สร้าง object EventTransactionInfo
    const newTransaction: any = {
      eventID,
      date: moment().tz("Asia/Bangkok").format("YYYY-MM-DD"),
      time: moment().tz("Asia/Bangkok").format("HH:mm:ss"),
      state: transactionState.new, // สถานะเริ่มต้นเป็น new
      retriesCount: 0,
      timeStamp: Date.now(),
      parameters: params,
      type: "ERPSync",
    };

    // push ลง Firebase (การทำงานแบบ Asynchronous เริ่มต้นขึ้นที่นี่)
    await CallUipathAPITransactionQueue.push(newTransaction);

    console.log(`[Portal] New ERPSync transaction accepted: ${eventID}`);

    // ส่ง Response 202 Accepted กลับทันที พร้อม URL สำหรับตรวจสอบสถานะ
    // 202 Accepted เป็น HTTP Status Code ที่เหมาะสมที่สุดสำหรับการทำงานแบบ Asynchronous
    res.status(202).json({ 
        success: true, 
        id: eventID, 
        message: "Transaction accepted for processing.",
        status_url: `/status/${eventID}` // แจ้ง Client ให้ไป Polling ที่นี่
    });

  } catch (err: any) {
    console.error("[Portal] Error creating transaction:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  }
});

appServer.get("/status/:id", async (req, res) => {
    const eventID = req.params.id;

    if (!eventID) {
        return res.status(400).json({ error: "Missing transaction ID." });
    }

    try {
        // ดึง Transaction จาก Firebase โดยตรง
        // เนื่องจากเราใช้ .push() ใน /Sync, eventID คือค่าที่อยู่ในฟิลด์ eventID ของ Data
        // เราจึงต้องค้นหาจาก children ทั้งหมด
        
        // **ข้อควรระวัง:** การค้นหาแบบนี้ (Query) ใน Realtime DB อาจมี Performance Issue หากมีข้อมูลมาก
        // แต่เป็นวิธีที่จำเป็นเมื่อใช้ .push() และต้องการดึงตาม eventID 
        const snapshot = await CallUipathAPITransactionQueue.orderByChild("eventID").equalTo(eventID).limitToFirst(1).once('value');
        
        if (!snapshot.exists() || snapshot.val() === null) {
            return res.status(404).json({ error: "Transaction not found." });
        }

        const transactionDataContainer = snapshot.val();
        const firebaseKey = Object.keys(transactionDataContainer)[0];
        const transaction: any = transactionDataContainer[firebaseKey];
        
        let finalStatus = 'processing';
        let responseCode = 200;
        let responseMessage = 'Transaction is currently being processed or is waiting in the queue.';
        
        // แปลงสถานะจาก transactionState ที่คุณกำหนดไว้
        if (transaction.state === transactionState.successful) {
            finalStatus = 'successful';
            responseMessage = 'Transaction completed successfully.';
        } else if (transaction.state === transactionState.failed || transaction.state === transactionState.takeover) {
            // เราสมมติว่า state.takeover หลัง finalize ถูกมองว่าเป็น failure ที่ต้องมีการจัดการ
            finalStatus = 'failed';
            responseMessage = `Transaction failed (State: ${transaction.state}).`;
            responseCode = 400; // อาจส่ง 400 Bad Request หรือ 500 Internal Server Error ขึ้นอยู่กับบริบทของความล้มเหลว
        } else if (transaction.state === transactionState.new || transaction.state === transactionState.pending || transaction.state === transactionState.process || transaction.state === transactionState.finalize) {
            finalStatus = 'processing';
        }
        
        res.status(responseCode).json({
            id: eventID,
            status: finalStatus,
            state: transaction.state, // สถานะภายใน (new, process, finalize, successful, failed, takeover)
            message: responseMessage,
            created_at: `${transaction.date} ${transaction.time}`
        });

    } catch (err: any) {
        console.error(`[Portal] Error checking status for ${eventID}:`, err);
        res.status(500).json({ error: "Internal Server Error during status check." });
    }
});

appServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Internal portal listening on http://localhost:${PORT}`);
});

const checkValidParameter = (
  param: any
): false | Partial<Record<parametersKey, any>> => {
  if (param === undefined || param === null) return false;
  if (typeof param !== "object") return false;

  const companyId = param["company_id"] || param["COMPANY-ID"];
  const contactId = param["contact_id"] || param["CONTACT-ID"];
  const tableName = param["table_name"] || param["TABLE-NAME"];
  const status = param["status"] || param["STATUS"];

  const validParam: Partial<Record<parametersKey, any>> = {};

  if (!((companyId && contactId) || (companyId && !contactId)) || !tableName) {
    return false;
  }

  if (companyId) validParam["COMPANY_ID"] = companyId;
  if (contactId) validParam["CONTACT_ID"] = contactId;
  if (tableName) validParam["TABLE_NAME"] = tableName;
  if (status) validParam["STATUS"] = status;

  return validParam;
};
