import { Router } from "express";
import { Register, Validator } from "../../utility/Validator";
import { cassandra } from "../..";
import { Generator } from "../../utility/Generator";
import bcrypt from "bcrypt";

const router = Router();

router.post("/register", async (req, res) => {
    const { error } = Validator.register(req.body);
    if (error) return res.status(401).json(error.details[0]);

    const { email, global_name, username, discriminator, password, dob, locale } = req.body as Register;

    try {
        const existsByUsernameAndDiscriminator = await cassandra.execute(`
        SELECT id, username, discriminator 
        FROM ${cassandra.keyspace}.users_by_username_and_discriminator 
        WHERE username=? AND discriminator=? 
        LIMIT 1;
        `, [username, discriminator], { prepare: true });

        const existsByEmail = await cassandra.execute(`
        SELECT id, email
        FROM ${cassandra.keyspace}.users_by_email 
        WHERE email=?
        LIMIT 1;
        `, [email]);

        if (existsByUsernameAndDiscriminator.rowLength > 0) return res.status(403).json({ message: "A user already exists with this username and discriminator." });
        if (existsByEmail.rowLength > 0) return res.status(403).json({ message: "A user already exists with this email." });

        const id = Generator.snowflake.generate();
        const secret = Generator.randomKey();
        const last_pass_reset = Date.now();

        const hashedPass = await bcrypt.hash(password, parseInt(process.env.PASSWORD_HASHING_SALT!));

        const insertEntries = Object.entries({
            id, email, username, global_name, locale, discriminator, dob, secret, last_pass_reset,
            password: hashedPass,
            bot: false,
            system: false,
            mfa_enabled: false,
            accent_color: null,
            verified: false,
            flags: 0,
            premium_type: 0,
            public_flags: 0,
            hide: false,
            created_at: Date.now(),
            edited_at: Date.now()
        });

        const sanitizedParams = insertEntries.map(([, value]) => {
            return value !== undefined ? value : null;
        });

        await cassandra.batch([
            {
                query: `INSERT INTO ${cassandra.keyspace}.users (
                            ${insertEntries.map(([key]) => key).join(',')}
                        ) VALUES (${insertEntries.map(() => '?').join(', ')});`,
                params: sanitizedParams
            },
            {
                query: `INSERT INTO ${cassandra.keyspace}.users_by_email (id, email) VALUES (?, ?);`,
                params: [id, email]
            },
            {
                query: `INSERT INTO ${cassandra.keyspace}.users_by_username_and_discriminator (id, username, discriminator) VALUES (?, ?, ?);`,
                params: [id, username, discriminator],
            }
        ], { prepare: true });

        const token = Generator.token(id, last_pass_reset, secret);
        return res.status(201).json({ token });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Internal Server Error" });
    }
});

router.post("/login", async (req, res) => {
    try {
        const { error } = Validator.login(req.body);
        if (error) return res.status(401).json({ message: "Incorrect Password" });
        const exists = await cassandra.execute(`
        SELECT id, email
        FROM ${cassandra.keyspace}.users_by_email 
        WHERE email=?
        LIMIT 1;
        `, [req.body.email], { prepare: true });

        if (exists.rowLength < 1) return res.status(404).json({ message: "User does not exist with this email." });

        const user = await cassandra.execute(`
        SELECT id, password, secret
        FROM ${cassandra.keyspace}.users
        WHERE id=?
        LIMIT 1;
        `, [exists.rows[0].get("id")], { prepare: true });

        if (!user) return res.status(500).json({ message: "Something went very wrong when trying to login, please contract strafe support!" });

        const validPass = await bcrypt.compare(req.body.password, user.rows[0].get("password"));
        if (!validPass) return res.status(401).json({ message: "The password you have entered is incorrect." });
        console.log(user.rows[0].get("id"));
        const token = Generator.token(user.rows[0].get("id"), Date.now(), user.rows[0].get("secret"));
        return res.status(200).json({ token });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Internal Server Error" });
    }
});

export default router;