import { Table, Column, Model, DataType, PrimaryKey, AutoIncrement, Unique, Default } from "sequelize-typescript";
import { Config } from "@/types/types";

@Table({
    tableName: "config_profiles",
    timestamps: true,
})
export class ConfigProfile extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column(DataType.INTEGER)
    id!: number;

    @Unique
    @Column(DataType.STRING)
    name!: string;

    @Column(DataType.TEXT)
    description?: string;

    @Column(DataType.JSON)
    config!: Config;

    @Default(false)
    @Column(DataType.BOOLEAN)
    isActive!: boolean;

    @Default(true)
    @Column(DataType.BOOLEAN)
    isEnabled!: boolean;
}
