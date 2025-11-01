/* 1. เรียกใช้เครื่องมือ (Dependencies) */
const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer'); 
const path = require('path'); 
const fs = require('fs');
const nodemailer = require('nodemailer'); 

const app = express();
// Railway จะกำหนด PORT ให้เราเอง ถ้าไม่เจอ (รันเครื่องตัวเอง) ให้ใช้ 3000
const PORT = process.env.PORT || 3000;

/* 2. ตั้งค่า Middleware */
app.use(express.json()); 
app.use(express.static('.')); 

const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* 3. ตั้งค่า Multer (เครื่องมืออัปโหลด) */
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage: storage });

/* 4. [แก้ไข] ตั้งค่าการเชื่อมต่อ (อ่านจาก Railway) */
const dbConfig = {
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT
};

async function getConnection() {
    return await mysql.createConnection(dbConfig);
}

/* 5. ฟังก์ชันสำหรับส่งอีเมล (ใช้ Gmail จริง) */
async function sendEmail(to, subject, html) {
    try {
        // --- ‼️ กรอกข้อมูลตรงนี้ ‼️ ---
        const SENDER_EMAIL = "preyapanngam2004@gmail.com"; 
        const SENDER_APP_PASSWORD = "iayz bwnr cyaj lstu"; 
        // --------------------------

        let transporter = nodemailer.createTransport({
            service: 'gmail', 
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: {
                user: SENDER_EMAIL, 
                pass: SENDER_APP_PASSWORD, 
            },
        });

        let info = await transporter.sendMail({
            from: `"ระบบลางานออนไลน์" <${SENDER_EMAIL}>`,
            to: to, 
            subject: subject, 
            html: html, 
        });

        console.log("Email sent successfully to:", to);

    } catch (error) {
        console.error("Error sending email:", error);
    }
}


/* === 6. สร้าง API Endpoints (ช่องทาง) === */

/* --- Process 1: จัดการการเข้าสู่ระบบ --- */
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const connection = await getConnection();
        const [rows] = await connection.execute(
            'SELECT * FROM Employees WHERE Username = ? AND Password = ?',
            [username, password]
        );
        await connection.end();
        if (rows.length > 0) {
            res.json({ success: true, user: rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'ชื่อผู้ใช้ หรือ รหัสผ่านไม่ถูกต้อง' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

/* --- Process 2: จัดการคำขอลางาน (ของพนักงาน) --- */

// API สำหรับดึงยอดคงเหลือ (D2)
app.get('/api/balances/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const connection = await getConnection();
        const [rows] = await connection.execute(
            'SELECT t.TypeName, b.RemainingDays FROM LeaveBalances b JOIN LeaveTypes t ON b.LeaveType_ID = t.LeaveType_ID WHERE b.Emp_ID = ?',
            [empId]
        );
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// API สำหรับดึงประวัติการลา (D3)
app.get('/api/history/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const connection = await getConnection();
        const [rows] = await connection.execute(
            'SELECT t.TypeName, r.StartDate, r.EndDate, r.Status FROM LeaveRequests r JOIN LeaveTypes t ON r.LeaveType_ID = t.LeaveType_ID WHERE r.Emp_ID = ? ORDER BY r.StartDate DESC',
            [empId]
        );
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// API สำหรับการยื่นใบลาใหม่ (Process 2.1, 2.2, 2.3)
app.post('/api/submit-leave', upload.single('attachment'), async (req, res) => {
    
    const { leaveType, startDate, endDate, reason, empId, managerId } = req.body;
    const attachmentPath = req.file ? req.file.path : null;

    const connection = await getConnection();
    try {
        await connection.beginTransaction(); 

        const totalDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) + 1;

        // 1. ตรวจสอบโควต้า (D2)
        const [balanceRows] = await connection.execute(
            'SELECT RemainingDays FROM LeaveBalances WHERE Emp_ID = ? AND LeaveType_ID = ? AND Year = 2025 FOR UPDATE',
            [empId, leaveType]
        );
        if (balanceRows.length === 0 || balanceRows[0].RemainingDays < totalDays) {
            await connection.rollback(); 
            return res.status(400).json({ message: 'แจ้งเตือนวันลาไม่พอ' });
        }

        // 2. บันทึกคำขอลา (D3)
        await connection.execute(
            'INSERT INTO LeaveRequests (Emp_ID, LeaveType_ID, StartDate, EndDate, Reason, Status, Approver_ID, AttachmentFile) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [empId, leaveType, startDate, endDate, reason, 'Pending', managerId, attachmentPath]
        );

        // 3. (Process 2.3) แจ้งเตือนหัวหน้า (ส่งอีเมลจริง)
        const [empRows] = await connection.execute(
            'SELECT FirstName, LastName FROM Employees WHERE Emp_ID = ?', [empId]
        );

        if (empRows.length > 0) {
            const managerEmail = "preyapanngam2004@gmail.com"; 
            
            const empName = `${empRows[0].FirstName} ${empRows[0].LastName}`;
            const subject = `[ระบบลางาน] มีใบลาใหม่รออนุมัติ จาก: ${empName}`;
            const html = `<h2>มีใบลาใหม่รออนุมัติ</h2>
                          <p>พนักงาน: <b>${empName}</b></p>
                          <p>ตั้งแต่วันที่ ${startDate} ถึง ${endDate}</p>
                          <p>เหตุผล: ${reason || '-'}</p>
                          <p>ไฟล์แนบ: ${attachmentPath || 'ไม่มี'}</p>
                          <p>กรุณาเข้าระบบเพื่อดำเนินการ</p>`;
            
            await sendEmail(managerEmail, subject, html);
        }

        await connection.commit(); 
        res.json({ success: true, message: 'ยื่นใบลาสำเร็จ' });

    } catch (error) {
        await connection.rollback(); 
        res.status(500).json({ message: error.message });
    } finally {
        await connection.end();
    }
});

/* --- Process 3: ประมวลผลการอนุมัติ (ของหัวหน้า) --- */
app.get('/api/pending-requests/:managerId', async (req, res) => {
    try {
        const { managerId } = req.params;
        const connection = await getConnection();
        const [rows] = await connection.execute(
            `SELECT r.Request_ID, e.FirstName, e.LastName, t.TypeName, r.StartDate, r.EndDate, r.Reason 
             FROM LeaveRequests r 
             JOIN Employees e ON r.Emp_ID = e.Emp_ID
             JOIN LeaveTypes t ON r.LeaveType_ID = t.LeaveType_ID
             WHERE r.Approver_ID = ? AND r.Status = 'Pending'`,
            [managerId]
        );
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/process-request', async (req, res) => {
    const { requestId, newStatus } = req.body; 
    
    const connection = await getConnection();
    try {
        await connection.beginTransaction();

        // 1. (Process 3.1) บันทึกผลอนุมัติ
        await connection.execute(
            'UPDATE LeaveRequests SET Status = ?, ApprovalDate = NOW() WHERE Request_ID = ?',
            [newStatus, requestId]
        );

        // 2. ดึงข้อมูลที่จำเป็น
        const [leaveInfoRows] = await connection.execute(
            `SELECT r.Emp_ID, r.LeaveType_ID, (DATEDIFF(r.EndDate, r.StartDate) + 1) AS TotalDays, 
                    e.Email AS EmployeeEmail, t.TypeName, r.StartDate
             FROM LeaveRequests r
             JOIN Employees e ON r.Emp_ID = e.Emp_ID
             JOIN LeaveTypes t ON r.LeaveType_ID = t.LeaveType_ID
             WHERE r.Request_ID = ?`, 
            [requestId]
        );
        
        if (leaveInfoRows.length === 0) {
            throw new Error('ไม่พบใบลา');
        }
        const leaveInfo = leaveInfoRows[0];

        // 3. (Process 3.2) ถ้าอนุมัติ ให้ตัดโควต้า (D2)
        if (newStatus === 'Approved') {
            await connection.execute(
                'UPDATE LeaveBalances SET RemainingDays = RemainingDays - ? WHERE Emp_ID = ? AND LeaveType_ID = ? AND Year = 2025',
                [leaveInfo.TotalDays, leaveInfo.Emp_ID, leaveInfo.LeaveType_ID]
            );
        }
        
        // 4. (Process 3.4) แจ้งเตือนพนักงาน (ส่งอีเมลจริง)
        if (leaveInfo.EmployeeEmail) {
            const subject = `[ระบบลางาน] ผลการอนุมัติใบลา: ${leaveInfo.TypeName}`;
            const statusInThai = newStatus === 'Approved' ? 'อนุมัติแล้ว' : 'ไม่อนุมัติ';
            const html = `<h2>ผลการอนุมัติใบลา</h2>
                          <p>ใบลา (ประเภท ${leaveInfo.TypeName}) ของคุณ (วันที่ ${leaveInfo.StartDate})</p>
                          <p>สถานะ: <b>${statusInThai}</b></p>`;
            
            await sendEmail(leaveInfo.EmployeeEmail, subject, html);
        } else {
            console.log(`ไม่สามารถส่งอีเมลแจ้งพนักงานได้ (ID: ${leaveInfo.Emp_ID}) เพราะไม่พบอีเมลในฐานข้อมูล`);
        }
        
        await connection.commit();
        res.json({ success: true, message: 'ดำเนินการสำเร็จ' });

    } catch (error) {
        await connection.rollback();
        res.status(500).json({ message: error.message });
    } finally {
        await connection.end();
    }
});


/* --- Process 4: ออกรายงาน (ของ HR/หัวหน้า) --- */
app.get('/api/report', async (req, res) => {
    const { dept, leaveType, startDate, endDate } = req.query;
    let query = `
        SELECT 
            e.FirstName, e.LastName, d.DeptName, t.TypeName, 
            r.StartDate, r.EndDate, r.Status,
            (DATEDIFF(r.EndDate, r.StartDate) + 1) AS TotalDays 
        FROM LeaveRequests r
        JOIN Employees e ON r.Emp_ID = e.Emp_ID
        JOIN Departments d ON e.Dept_ID = d.Dept_ID
        JOIN LeaveTypes t ON r.LeaveType_ID = t.LeaveType_ID
        WHERE 1=1
    `;
    const params = [];
    if (dept) query += ' AND e.Dept_ID = ?', params.push(dept);
    if (leaveType) query += ' AND r.LeaveType_ID = ?', params.push(leaveType);
    if (startDate) query += ' AND r.StartDate >= ?', params.push(startDate);
    if (endDate) query += ' AND r.EndDate <= ?', params.push(endDate);
    
    try {
        const connection = await getConnection();
        const [rows] = await connection.execute(query, params);
        await connection.end();
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

/* === 7. เริ่มรันเซิร์ฟเวอร์ === */
// เพิ่ม '0.0.0.0' เข้าไปตรงนี้ เพื่อให้ Railway รับการเชื่อมต่อจากภายนอกได้
app.listen(PORT, '0.0.0.0', () => {
 console.log(`Backend Server กำลังรันที่ port ${PORT}`);
});