import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Unique, Default } from "sequelize-typescript";

@Table({
    tableName: "users",
    timestamps: true,
})
export class User extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column(DataType.INTEGER)
    id!: number;

    @Unique
    @Column(DataType.STRING)
    email!: string;

    @Column(DataType.STRING)
    name!: string;

    @Default("user")
    @Column(DataType.STRING)
    role!: string; // 'admin' | 'user'

    @Default(true)
    @Column(DataType.BOOLEAN)
    isActive!: boolean;

    @Column(DataType.JSON)
    preferences?: {
        preferredContentType?: "movie" | "series" | "tv";
        favorites?: string[];
        recentChannels?: string[];
        videoFitMode?: string;
        lastSelectedCategory?: Record<string, string>;
        lastSelectedCategoryTitle?: Record<string, string>;
    };

    @Column(DataType.STRING)
    passwordHash?: string;

    @Column(DataType.STRING)
    salt?: string;

    @Column(DataType.STRING)
    avatarUrl?: string;
}
