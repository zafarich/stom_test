const {Bot, InlineKeyboard, Keyboard} = require("grammy");
const XLSX = require("xlsx");
const mongoose = require("mongoose");
const fs = require("fs");
const https = require("https");
require("dotenv").config();

// MongoDB ulanish URL
const mongoUrl =
  "mongodb://super_admin:suhi3800Azafar0000$@127.0.0.1:27017/quiz?authSource=admin";

// Mongoose sxemalarini yaratish
const questionSchema = new mongoose.Schema({
  question: String,
  correctAnswer: String,
  options: [String],
});

const ticketSchema = new mongoose.Schema({
  ticketNumber: Number,
  questions: [questionSchema],
});

const userSessionSchema = new mongoose.Schema({
  userId: Number,
  currentTest: [
    {
      question: String,
      correctAnswer: String,
      options: [String],
      userAnswer: String,
    },
  ],
  currentQuestionIndex: Number,
  currentCorrectIndex: Number,
  score: Number,
  isRandomTest: Boolean,
  ticketNumber: Number,
});

const Ticket = mongoose.model("Ticket", ticketSchema);

const UserSession = mongoose.model("UserSession", userSessionSchema);

// Bot tokenini o'zingizning botingiz tokeniga almashtiring
const bot = new Bot(process.env.BOT_TOKEN);

async function connectToMongo() {
  try {
    await mongoose.connect(mongoUrl);
    console.log("MongoDB ga muvaffaqiyatli ulandi");
  } catch (error) {
    console.error("MongoDB ga ulanishda xatolik:", error);
  }
}

async function saveQuestions(questions) {
  try {
    const tickets = [];
    for (let i = 0; i < questions.length; i += 10) {
      const ticket = new Ticket({
        ticketNumber: Math.floor(i / 10) + 1,
        questions: questions.slice(i, i + 10),
      });
      tickets.push(ticket);
    }

    await Ticket.insertMany(tickets);
    return tickets.length;
  } catch (error) {
    console.error("Saqlashda xatolik:", error);
    return 0;
  }
}

// Excel faylni qayta ishlash
function processExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, {header: 1});

  const questions = data
    .filter((row) => row.length >= 5)
    .map((row) => {
      // Barcha qiymatlarni string ga o'tkazamiz va bo'sh joylarni olib tashlaymiz
      const question = row[0].toString().trim();
      const correctAnswer = row[1].toString().trim();
      const options = [
        correctAnswer,
        row[2].toString().trim(),
        row[3].toString().trim(),
        row[4].toString().trim(),
      ];

      // Variantlarni aralashtirish
      const shuffledOptions = [...options].sort(() => Math.random() - 0.5);

      return {
        question: question,
        correctAnswer: correctAnswer,
        options: shuffledOptions,
      };
    })
    .filter((q) => q.question && q.correctAnswer);

  return questions;
}

async function getRandomQuestions(count) {
  const tickets = await Ticket.aggregate([
    {$unwind: "$questions"},
    {$sample: {size: count}},
    {
      $project: {
        "questions.question": 1,
        "questions.correctAnswer": 1,
        "questions.options": 1,
      },
    },
  ]);
  return tickets.map((t) => t.questions);
}

async function startNewTest(userId, isRandom = true) {
  try {
    let questions;
    if (isRandom) {
      questions = await getRandomQuestions(40);
    } else {
      const ticket = await Ticket.findOne({ticketNumber: 1});
      questions = ticket.questions;
    }

    const session = new UserSession({
      userId,
      currentTest: questions.map((q) => ({
        ...q,
        userAnswer: null,
      })),
      currentQuestionIndex: 0,
      score: 0,
      isRandomTest: isRandom,
    });
    await session.save();
    return session;
  } catch (error) {
    console.error("Test boshlashda xatolik:", error);
    return null;
  }
}

async function sendQuestion(ctx, session) {
  const currentQuestion = session.currentTest[session.currentQuestionIndex];
  const keyboard = new InlineKeyboard();

  let questionText = "";

  if (!session.isRandomTest) {
    questionText += `${session.ticketNumber}-билет\n\n`;
  }

  questionText += `Савол ${session.currentQuestionIndex + 1}/${
    session.currentTest.length
  }:\n\n`;
  questionText += currentQuestion.question + "\n\n";
  questionText += "Вариантлар:\n";
  const variants_keys = ["А", "Б", "В", "Г"];

  // To'g'ri javob belgisini ko'rsatmaslik
  currentQuestion.options.forEach((option, index) => {
    questionText += `${variants_keys[index]}) ${option}\n`;
  });
  ["А", "Б", "В", "Г"].forEach((letter, index) => {
    keyboard.text(letter, `opt_${index}`);
    if (index % 2 === 1) keyboard.row();
  });

  session.currentCorrectIndex = currentQuestion.options.indexOf(
    currentQuestion.correctAnswer,
  );
  await session.save();

  await ctx.reply(questionText, {reply_markup: keyboard});
}

// Botga kelgan xabarlarni qayta ishlash
bot.command("start", async (ctx) => {
  const keyboard = new Keyboard()
    .text("🎲 Имтихон олиш")
    .text("📚 Билетлар")
    .row()
    .resized();

  await ctx.reply(
    "Ассалому алайкум! Тест топшириш учун қуйидаги менюдан фойдаланинг:",
    {reply_markup: keyboard},
  );
});

bot.on("message:document", async (ctx) => {
  try {
    if (
      ctx.message.document.mime_type ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const file = await ctx.getFile();
      const filePath = "./temp.xlsx";

      // Faylni yuklab olish
      const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
      const fileStream = fs.createWriteStream(filePath);

      await new Promise((resolve, reject) => {
        https
          .get(fileUrl, (response) => {
            response.pipe(fileStream);
            fileStream.on("finish", () => {
              fileStream.close();
              resolve();
            });
          })
          .on("error", (err) => {
            fs.unlink(filePath, () => reject(err));
          });
      });

      const questions = processExcel(filePath);
      const ticketCount = await saveQuestions(questions);

      fs.unlinkSync(filePath);

      await ctx.reply(
        `Excel файл муваффақиятли қайта ишланди!\nЖами ${ticketCount} та билет яратилди.\nҲар бир билетда 10 тадан савол мавжуд.`,
      );
    } else {
      await ctx.reply("Илтимос, Excel (.xlsx) форматидаги файл юборинг!");
    }
  } catch (error) {
    console.error("Хатолик юз берди:", error);
    await ctx.reply(
      "Файлни қайта ишлашда хатолик юз берди. Илтимос, қайтадан уриниб кўринг.",
    );
  }
});

bot.hears("🎲 Имтихон олиш", async (ctx) => {
  await UserSession.deleteMany({userId: ctx.from.id});

  const session = await startNewTest(ctx.from.id);
  if (session) {
    await sendQuestion(ctx, session);
  } else {
    await ctx.reply(
      "Тест бошлашда хатолик юз берди. Илтимос, қайтадан уриниб кўринг.",
    );
  }
});

bot.hears("📚 Билетлар", async (ctx) => {
  await UserSession.deleteMany({userId: ctx.from.id});

  const tickets = await Ticket.distinct("ticketNumber");
  const keyboard = new InlineKeyboard();

  tickets.forEach((ticketNum, index) => {
    keyboard.text(`${ticketNum}-билет`, `bilet_${ticketNum}`);
    if (index % 3 === 2) keyboard.row();
  });
  if (tickets.length % 3 !== 0) keyboard.row();

  keyboard.text("📝 Билетни ечиш", "solve_ticket").row();

  await ctx.reply("Билетни танланг:", {reply_markup: keyboard});
});

async function handleTicketSelection(ctx, ticketNumber) {
  // Avval eski sessiyani o'chiramiz
  await UserSession.deleteMany({userId: ctx.from.id});

  // Yangi sessiya yaratamiz
  const ticket = await Ticket.findOne({ticketNumber});
  if (!ticket) {
    await ctx.reply("Билет топилмади!");
    return;
  }

  const session = new UserSession({
    userId: ctx.from.id,
    ticketNumber: ticketNumber,
    isRandomTest: false,
    currentTest: ticket.questions.map((q) => ({
      ...q,
      userAnswer: null,
    })),
    currentQuestionIndex: 0,
    score: 0,
  });
  await session.save();

  // Biletdagi barcha savollarni ko'rsatamiz
  let fullTicketText = `${ticketNumber}-билет\n\n`;

  ticket.questions.forEach((question, i) => {
    fullTicketText += `Савол ${i + 1}:\n`;
    fullTicketText += question.question + "\n\n";
    fullTicketText += "Вариантлар:\n";

    const variants_keys = ["А", "Б", "В", "Г"];
    question.options.forEach((option, optionIndex) => {
      const isCorrectAnswer = option === question.correctAnswer;
      fullTicketText += `${isCorrectAnswer ? "+ " : ""}${
        variants_keys[optionIndex]
      }) ${option}\n`;
    });

    fullTicketText += "\n------------------------\n\n";
  });

  await ctx.reply(fullTicketText);
}

async function handleAnswer(ctx) {
  const session = await getSession(ctx);
  const data = ctx.callbackQuery.data;
  const [_, selectedAnswer, ticketNumber] = data.split("_");

  let responseText = `${ticketNumber}-билет учун жавоблар:\n\n`;

  // 10 ta savol uchun to'g'ri javoblarni ko'rsatish
  session.currentTest.slice(0, 10).forEach((question, index) => {
    const isCorrect =
      question.correctAnswer ===
      question.options[getAnswerIndex(selectedAnswer)];
    responseText += `${index + 1}. ${isCorrect ? "✅" : "❌"} Тўғри жавоб: ${
      question.correctAnswer
    }\n`;
  });

  await ctx.reply(responseText);
}

function getAnswerIndex(answer) {
  const answerMap = {A: 0, B: 1, C: 2, D: 3};
  return answerMap[answer];
}

async function getSession(ctx) {
  return await UserSession.findOne({userId: ctx.from.id});
}

async function getTicketQuestions(ticketNumber) {
  const ticket = await Ticket.findOne({ticketNumber});
  return ticket ? ticket.questions : [];
}

bot.on("callback_query", async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery.data;

    if (callbackData === "solve_ticket") {
      const keyboard = new InlineKeyboard();
      const tickets = await Ticket.distinct("ticketNumber");

      tickets.forEach((ticketNum, index) => {
        keyboard.text(`${ticketNum}`, `solve_${ticketNum}`);
        if (index % 3 === 2) keyboard.row();
      });
      if (tickets.length % 3 !== 0) keyboard.row();

      await ctx.reply("Ечиш учун билетни танланг:", {reply_markup: keyboard});
    } else if (callbackData.startsWith("solve_")) {
      const ticketNum = parseInt(callbackData.split("_")[1]);
      await startTicketTest(ctx, ticketNum);
    } else if (callbackData.startsWith("bilet_")) {
      const ticketNum = parseInt(callbackData.split("_")[1]);
      await handleTicketSelection(ctx, ticketNum);
    }
  } catch (error) {
    console.error("Callback query ishlovida xatolik:", error);
  }
});

async function startTicketTest(ctx, ticketNumber) {
  await UserSession.deleteMany({userId: ctx.from.id});

  const ticket = await Ticket.findOne({ticketNumber});
  if (!ticket) {
    await ctx.reply("Билет топилмади!");
    return;
  }

  const session = new UserSession({
    userId: ctx.from.id,
    ticketNumber: ticketNumber,
    isRandomTest: false,
    currentTest: ticket.questions.map((q) => ({
      ...q.toObject(),
      userAnswer: null,
    })),
    currentQuestionIndex: 0,
    score: 0,
  });
  await session.save();

  await sendQuestion(ctx, session);
}

// Botni ishga tushirish
connectToMongo().then(() => {
  bot.start();
  console.log("Bot ishga tushdi!");
});
